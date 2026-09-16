// Pop Radio – kleiner lokaler Server (keine Abhängigkeiten, Node 18+)
// Start: node server.js  →  http://localhost:3000

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // im LXC: 0.0.0.0
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PopRadio/1.0';
const RADIO_BROWSER = 'https://de1.api.radio-browser.info';
const PUBLIC_DIR = path.join(__dirname, 'public');

const stationCache = new Map(); // homepage -> { time, data }

// ---------- Hilfsfunktionen ----------

async function fetchText(url, { timeout = 8000, maxBytes = 3_000_000 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { text: buf.subarray(0, maxBytes).toString('utf8'), url: res.url, type: res.headers.get('content-type') || '' };
}

function decodeEntities(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const stripTags = (s = '') => decodeEntities(decodeEntities(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// Attribute mit einem festen Ausdruck durchgehen (keine dynamische RegExp)
const ATTR_RE = /([^\s=<>"'/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;

function attr(tag, name) {
  const wanted = name.toLowerCase();
  for (const m of tag.matchAll(ATTR_RE)) {
    if (m[1].toLowerCase() === wanted) return decodeEntities(m[2] ?? m[3] ?? m[4]);
  }
  return null;
}

// Inhalt des ersten <name …>…</name> in einem XML-Block (XML unterscheidet Groß-/Kleinschreibung)
function innerTag(block, name) {
  const open = `<${name}`;
  let i = block.indexOf(open);
  while (i >= 0 && !/[\s>/]/.test(block[i + open.length] || '')) i = block.indexOf(open, i + 1);
  if (i < 0) return null;
  const start = block.indexOf('>', i);
  if (start < 0 || block[start - 1] === '/') return null; // selbstschließend, z. B. <link href="…"/>
  const end = block.indexOf(`</${name}>`, start);
  return end < 0 ? null : block.slice(start + 1, end);
}

function metaContent(html, key) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const k = (attr(tag, 'property') || attr(tag, 'name') || '').toLowerCase();
    if (k === key) return attr(tag, 'content');
  }
  return null;
}

const bareHost = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const absUrl = (href, base) => { try { return new URL(href, base).href; } catch { return null; } };

function normalizeInput(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new Error('Keine URL angegeben');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  return u.href;
}

// ---------- ICY-Metadaten aus dem Stream lesen ----------

function readIcy(streamUrl, redirects = 0) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(streamUrl); } catch { return resolve(null); }
    const secure = u.protocol === 'https:';
    const opts = { host: u.hostname, port: u.port || (secure ? 443 : 80), servername: u.hostname };
    const sock = secure ? tls.connect(opts) : net.connect(opts);
    let finished = false;
    const finish = (v) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), 10000);

    sock.on('error', () => finish(null));
    sock.on(secure ? 'secureConnect' : 'connect', () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.0\r\n` +
        `Host: ${u.host}\r\nUser-Agent: ${UA}\r\nIcy-MetaData: 1\r\nAccept: */*\r\nConnection: close\r\n\r\n`
      );
    });

    let buf = Buffer.alloc(0);
    let headers = null;
    let metaint = 0;
    let info = {};

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (!headers) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) { if (buf.length > 32000) finish(null); return; }
        const lines = buf.subarray(0, idx).toString('latin1').split('\r\n');
        const status = parseInt(lines[0].split(' ')[1], 10);
        headers = {};
        for (const l of lines.slice(1)) {
          const i = l.indexOf(':');
          if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
        }
        if (status >= 300 && status < 400 && headers.location && redirects < 5) {
          const next = absUrl(headers.location, u);
          finished = true;
          clearTimeout(timer);
          sock.destroy();
          return resolve(readIcy(next, redirects + 1));
        }
        if (status !== 200) return finish(null);
        info = {
          stationName: headers['icy-name'] || null,
          genre: headers['icy-genre'] || null,
          bitrate: headers['icy-br'] || null,
          contentType: headers['content-type'] || null,
        };
        metaint = parseInt(headers['icy-metaint'], 10);
        if (!metaint) return finish({ ...info, streamTitle: null });
        buf = buf.subarray(idx + 4);
      }

      // Metadatenblöcke abarbeiten (leere Blöcke überspringen, bis ein Titel kommt)
      while (buf.length > metaint) {
        const len = buf[metaint] * 16;
        if (buf.length < metaint + 1 + len) return;
        if (len > 0) {
          const raw = buf.subarray(metaint + 1, metaint + 1 + len);
          let text = raw.toString('utf8');
          if (text.includes('�')) text = raw.toString('latin1');
          const m = text.match(/StreamTitle='([\s\S]*?)';/);
          return finish({ ...info, streamTitle: m ? m[1].trim() : null });
        }
        buf = buf.subarray(metaint + 1);
      }
    });
    sock.on('end', () => finish(headers ? { ...info, streamTitle: null } : null));
  });
}

// Playlists (.m3u / .pls) in echte Stream-URLs auflösen
async function resolveStream(url) {
  if (!/\.(m3u|pls)(\?|$)/i.test(url)) return url;
  try {
    const { text } = await fetchText(url, { timeout: 5000, maxBytes: 50000 });
    const m = text.match(/https?:\/\/[^\s"'<>]+/);
    return m ? m[0] : url;
  } catch {
    return url;
  }
}

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9äöü]/g, '');

function splitTitle(streamTitle, stationName) {
  if (!streamTitle) return { artist: null, song: null, isSong: false };
  const [main, ...extra] = streamTitle.split(/\s+\|\s+/); // z. B. "Artist - Song | Sendung"
  const parts = main.split(/\s+[-–—]\s+/);
  const artist = parts.length >= 2 ? parts[0].trim() : null;
  const song = parts.length >= 2 ? parts.slice(1).join(' - ').trim() : main.trim();
  // Senderkennung statt Song? (z. B. "ANTENNE BAYERN - Wir lieben Bayern")
  const a = normName(artist || song);
  const st = normName(stationName);
  const isSong = !!artist && !(st && a.length > 2 && (st.includes(a) || a.includes(st)));
  return { artist, song, isSong, show: extra.join(' · ') || null };
}

// ---------- Sender erkennen ----------

async function searchRadioBrowser(term) {
  if (!term || term.length < 2) return [];
  const url = `${RADIO_BROWSER}/json/stations/search?name=${encodeURIComponent(term)}&limit=100&hidebroken=true&order=clickcount&reverse=true`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

function findStreamsInHtml(html, base) {
  const found = new Set();
  const re = /https?:\/\/[^\s"'<>\\]+?(?:\.(?:mp3|aac|pls|m3u)(?:\?[^\s"'<>\\]*)?|\/(?:stream|live)[^\s"'<>\\]*|streamtheworld\.com[^\s"'<>\\]*|\/;)/gi;
  for (const m of html.matchAll(re)) {
    const u = absUrl(m[0].replace(/&amp;/g, '&'), base);
    if (u && !/\.(js|css|png|jpe?g|svg|webp|html?)(\?|$)/i.test(u) && !/m3u8/i.test(u)) found.add(u);
  }
  return [...found].slice(0, 8);
}

function findFeeds(html, base) {
  const feeds = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const type = (attr(tag, 'type') || '').toLowerCase();
    if (/(rss|atom)\+xml/.test(type) && attr(tag, 'href')) {
      const u = absUrl(attr(tag, 'href'), base);
      if (u && !/comments/i.test(u)) feeds.push(u);
    }
  }
  return [...new Set(feeds)];
}

async function probeFeeds(base) {
  const candidates = ['/feed/', '/rss', '/rss.xml', '/feed.xml', '/news/rss', '/index.rss'].map((p) => absUrl(p, base));
  const results = await Promise.all(candidates.map(async (u) => {
    try {
      const { text } = await fetchText(u, { timeout: 4000, maxBytes: 200000 });
      return /<(rss|feed)\b/i.test(text.slice(0, 2000)) ? u : null;
    } catch { return null; }
  }));
  return results.filter(Boolean).slice(0, 1);
}

function scrapeHeadlines(html, base) {
  const items = [];
  const seen = new Set();
  const blocks = html.match(/<article\b[\s\S]*?<\/article>/gi) || [];
  for (const block of blocks) {
    const h = block.match(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i);
    const a = block.match(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/i);
    const title = h ? stripTags(h[1]) : null;
    if (title && title.length > 12 && !seen.has(title)) {
      seen.add(title);
      items.push({ title, link: a ? absUrl(decodeEntities(a[1]), base) : base, date: null, summary: null });
    }
    if (items.length >= 15) break;
  }
  if (items.length >= 3) return items;

  // Zweiter Versuch: Links, die eine Überschrift enthalten (oder umgekehrt)
  const linkRe = /<a\b([^>]*)>([\s\S]{0,1500}?)<\/a>/gi;
  const headRe = /<h([2-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  const candidates = [];
  for (const m of html.matchAll(linkRe)) {
    const hm = m[2].match(/<h[2-4]\b[^>]*>([\s\S]*?)<\/h[2-4]>/i);
    if (hm) candidates.push({ title: stripTags(hm[1]), href: attr(m[1], 'href') });
  }
  for (const m of html.matchAll(headRe)) {
    const am = m[2].match(/<a\b([^>]*)>/i);
    if (am) candidates.push({ title: stripTags(m[2]), href: attr(am[1], 'href') });
  }
  for (const c of candidates) {
    if (!c.href || c.title.length < 20 || seen.has(c.title)) continue;
    const link = absUrl(c.href, base);
    if (!link || bareHost(link) !== bareHost(base)) continue;
    seen.add(c.title);
    items.push({ title: c.title, link, date: null, summary: null });
    if (items.length >= 15) break;
  }
  return items;
}

// ---------- radio.de / radio.net ----------

const RADIO_DE_API = 'https://prod.radio-api.net';
const RADIO_DE_LANG = { de: 'de-DE', at: 'de-AT', net: 'en-GB', fr: 'fr-FR', it: 'it-IT', es: 'es-ES', pt: 'pt-PT', pl: 'pl-PL', dk: 'da-DK', se: 'sv-SE' };

// "radio.de/s/1live" → { id: "1live", tld: "de" }
function parseRadioDe(input) {
  try {
    const u = new URL(normalizeInput(input));
    const host = u.hostname.match(/(?:^|\.)radio\.(de|net|at|fr|it|es|pt|pl|dk|se)$/);
    const id = u.pathname.match(/^\/s\/([^/?#]+)/);
    return host && id ? { id: decodeURIComponent(id[1]).toLowerCase(), tld: host[1] } : null;
  } catch {
    return null;
  }
}

async function radioDeApi(pathAndQuery, tld = 'de') {
  const res = await fetch(`${RADIO_DE_API}${pathAndQuery}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': RADIO_DE_LANG[tld] || 'de-DE' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`radio.de antwortet mit HTTP ${res.status}`);
  return res.json();
}

async function radioDeNowPlaying(id) {
  try {
    const [entry] = await radioDeApi(`/stations/now-playing?stationIds=${encodeURIComponent(id)}`);
    return entry?.title?.trim() || null;
  } catch {
    return null;
  }
}

async function findNews(html, url) {
  if (!html) return { feeds: [], headlines: [] };
  let feeds = findFeeds(html, url);
  if (!feeds.length) feeds = await probeFeeds(url);
  return { feeds, headlines: feeds.length ? [] : scrapeHeadlines(html, url) };
}

async function detectRadioDe({ id, tld }) {
  const [st] = await radioDeApi(`/stations/details?stationIds=${encodeURIComponent(id)}`, tld);
  if (!st) throw new Error(`Sender "${id}" gibt es auf radio.${tld} nicht`);

  // Homepage des Senders nur noch für die News laden
  let html = '';
  let homepage = st.homepageUrl || null;
  if (homepage) {
    try {
      const r = await fetchText(homepage);
      html = r.text;
      homepage = r.url;
    } catch (e) {
      console.warn('Homepage nicht erreichbar:', homepage, e.message);
    }
  }

  const format = (type = '') => (/mpeg|mp3/i.test(type) ? 'MP3' : /aac/i.test(type) ? 'AAC' : /ogg/i.test(type) ? 'OGG' : type.split('/').pop()?.toUpperCase() || 'Stream');
  const streams = (st.streams || [])
    .filter((s) => s.url && s.status !== 'INVALID')
    .sort((a, b) => Number(/mpeg/.test(b.contentFormat)) - Number(/mpeg/.test(a.contentFormat)));
  const formatCount = {};
  const channels = streams.map((s) => ({
    name: streams.length > 1 ? `${st.name} · ${format(s.contentFormat)}` : st.name,
    stream: s.url,
    logo: null,
    tags: (st.genres || []).join(','),
    codec: format(s.contentFormat),
    bitrate: null,
  }));
  for (const c of channels) { // doppelte Namen durchnummerieren
    formatCount[c.name] = (formatCount[c.name] || 0) + 1;
    if (formatCount[c.name] > 1) c.name += ` (${formatCount[c.name]})`;
  }

  const pageUrl = `https://www.radio.${tld}/s/${st.id}`;
  return {
    key: pageUrl,
    source: `radio.${tld}`,
    radioDeId: st.id,
    radioDeUrl: pageUrl,
    homepage: homepage || pageUrl,
    host: `radio.${tld}`,
    name: st.name,
    description: st.shortDescription || st.description || '',
    genres: st.genres || [],
    city: st.city || null,
    logo: st.logo300x300 || st.logo175x175 || null,
    channels,
    ...(await findNews(html, homepage)),
  };
}

async function detectStation(input) {
  const homepage = normalizeInput(input);
  const cached = stationCache.get(homepage);
  if (cached && Date.now() - cached.time < 30 * 60 * 1000) return cached.data;

  const radioDe = parseRadioDe(input);
  if (radioDe) {
    const data = await detectRadioDe(radioDe);
    stationCache.set(homepage, { time: Date.now(), data });
    return data;
  }
  if (/(^|\.)radio\.(de|net|at|fr|it|es|pt|pl|dk|se)$/.test(bareHost(homepage))) {
    throw new Error('Bitte den Link einer Senderseite einfügen, z. B. radio.de/s/1live');
  }

  let html = '';
  let finalUrl = homepage;
  try {
    const r = await fetchText(homepage);
    html = r.text;
    finalUrl = r.url;
  } catch (e) {
    console.warn('Website nicht erreichbar:', homepage, e.message);
  }

  const host = bareHost(finalUrl) || bareHost(homepage);
  const siteName = metaContent(html, 'og:site_name');
  const pageTitle = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const shortTitle = pageTitle.split(/\s[|–—-]\s/)[0].trim();
  const domainLabel = host.split('.').slice(-2, -1)[0] || host;

  // radio-browser.info nach passenden Sendern durchsuchen
  const terms = [...new Set([siteName, shortTitle, domainLabel].filter(Boolean))];
  const results = (await Promise.all(terms.map(searchRadioBrowser))).flat();
  const seen = new Set();
  let matches = results.filter((s) => {
    const h = bareHost(s.homepage);
    const ok = h && (h === host || h.endsWith('.' + host) || host.endsWith('.' + h));
    if (!ok || seen.has(s.stationuuid)) return false;
    seen.add(s.stationuuid);
    return true;
  });
  if (!matches.length && siteName) {
    matches = results.filter((s) => s.name.trim().toLowerCase() === siteName.trim().toLowerCase()).slice(0, 1);
  }
  // Sender, deren Name zur eingegebenen Domain / zum Seitennamen passt, nach vorne
  const norm = normName;
  const inputLabel = norm(bareHost(homepage).split('.').slice(-2, -1)[0]);
  const wanted = [inputLabel, norm(siteName), norm(shortTitle)].filter((w) => w.length >= 2);
  const score = (s) => {
    const n = norm(s.name);
    return wanted.some((w) => n === w) ? 2 : wanted.some((w) => n.includes(w) || w.includes(n)) ? 1 : 0;
  };
  // Zusatzwörter wie "Diggi" oder "National" deuten auf Unterkanäle hin → Hauptsender bevorzugen
  const noise = new Set(['mp3', 'aac', 'aacplus', 'ogg', 'kbit', 'kbps', 's', 'http', 'https', 'hq', 'lq', 'stream', 'livestream', 'live', 'radio', 'fm', 'webradio', 'de', 'online']);
  const extraWords = (s) => s.name.toLowerCase().split(/[^a-z0-9äöü]+/)
    .filter((t) => t && !noise.has(t) && !/^\d+$/.test(t) && !wanted.some((w) => w === t || w.includes(t))).length;
  matches.sort((a, b) => score(b) - score(a) || extraWords(a) - extraWords(b) || b.clickcount - a.clickcount);

  const channels = matches.slice(0, 20).map((s) => ({
    name: s.name.trim(),
    stream: s.url_resolved || s.url,
    logo: s.favicon || null,
    tags: s.tags || '',
    codec: s.codec,
    bitrate: s.bitrate,
  }));

  // Streams direkt auf der Website suchen
  for (const stream of findStreamsInHtml(html, finalUrl)) {
    if (!channels.some((c) => c.stream === stream)) {
      channels.push({ name: `Stream von ${host}`, stream, logo: null, tags: '', codec: null, bitrate: null });
    }
  }

  const news = await findNews(html, finalUrl);

  const iconTag = (html.match(/<link\b[^>]*rel=["'][^"']*(apple-touch-icon|icon)[^"']*["'][^>]*>/i) || [])[0];
  const logo =
    channels.find((c) => c.logo)?.logo ||
    absUrl(metaContent(html, 'og:image') || '', finalUrl) ||
    (iconTag && absUrl(attr(iconTag, 'href'), finalUrl)) ||
    `https://www.google.com/s2/favicons?domain=${host}&sz=128`;

  const data = {
    key: finalUrl,
    source: host,
    homepage: finalUrl,
    host,
    name: (matches[0] && score(matches[0]) === 2 ? matches[0].name.trim() : null) ||
      (siteName && !siteName.includes('.') ? siteName : null) ||
      (shortTitle.length <= 30 ? shortTitle : null) || channels[0]?.name || host,
    description: stripTags(metaContent(html, 'og:description') || metaContent(html, 'description') || ''),
    logo,
    genres: [],
    city: null,
    channels,
    ...news,
  };
  stationCache.set(homepage, { time: Date.now(), data });
  return data;
}

// ---------- News aus RSS/Atom ----------

async function readFeed(feedUrl) {
  const { text } = await fetchText(feedUrl);
  const blocks = text.match(/<item\b[\s\S]*?<\/item>/gi) || text.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  const tag = innerTag;
  const feedTitle = stripTags(tag(text.replace(/<(item|entry)\b[\s\S]*/i, ''), 'title') || '');
  const items = blocks.slice(0, 25).map((b) => {
    let link = stripTags(tag(b, 'link') || '');
    if (!link) {
      const l = b.match(/<link\b[^>]*>/i);
      link = l ? attr(l[0], 'href') : null;
    }
    const img = b.match(/<(?:media:content|media:thumbnail|enclosure)\b[^>]*url=["']([^"']+)["'][^>]*>/i);
    const summary = stripTags(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content') || '');
    return {
      title: stripTags(tag(b, 'title') || ''),
      link: absUrl(link || '', feedUrl),
      date: stripTags(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date') || '') || null,
      summary: summary.length > 220 ? summary.slice(0, 217) + '…' : summary,
      image: img ? decodeEntities(img[1]) : null,
    };
  }).filter((i) => i.title);
  return { feedTitle, items };
}

// ---------- HTTP-Server ----------

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// Auslieferbare Dateien einmal beim Start einlesen. Anfragen werden nur nachgeschlagen
// und nie zu Dateipfaden zusammengesetzt (neue Dateien brauchen einen Neustart).
function listFiles(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory()
    ? listFiles(path.join(dir, e.name), `${prefix}/${e.name}`)
    : [[`${prefix}/${e.name}`, path.join(dir, e.name)]]);
}
const STATIC_FILES = new Map(listFiles(PUBLIC_DIR));

function serveStatic(res, pathname) {
  const file = STATIC_FILES.get(pathname === '/' ? '/index.html' : pathname);
  if (!file) return sendJson(res, 404, { error: 'Nicht gefunden' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Nicht gefunden' });
    res.writeHead(200, { 'Content-Type': (MIME[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(data);
  });
}

async function handleRequest(req, res) {
  try {
    // Feste Basis statt Host-Header: ein kaputter Host darf den Server nicht abstürzen lassen
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    if (pathname === '/api/station') {
      return sendJson(res, 200, await detectStation(searchParams.get('url')));
    }
    if (pathname === '/api/nowplaying') {
      // radio.de kennt den Titel meist auch dann, wenn der Stream nur den Slogan sendet
      const rid = searchParams.get('rid');
      const title = rid && (await radioDeNowPlaying(rid));
      if (title) {
        return sendJson(res, 200, { ok: true, source: 'radio.de', streamTitle: title, ...splitTitle(title, searchParams.get('name')) });
      }
      const stream = await resolveStream(normalizeInput(searchParams.get('stream')));
      const icy = await readIcy(stream);
      if (!icy) return sendJson(res, 200, { ok: false, stream });
      const stationName = icy.stationName || searchParams.get('name');
      return sendJson(res, 200, { ok: true, stream, ...icy, ...splitTitle(icy.streamTitle, stationName) });
    }
    if (pathname === '/api/news') {
      return sendJson(res, 200, await readFeed(normalizeInput(searchParams.get('feed'))));
    }
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Unbekannter Endpunkt' });
    return serveStatic(res, pathname);
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
  }
}

// HTTPS, wenn TLS_CERT und TLS_KEY gesetzt sind. Sonst HTTP – gedacht fürs Heimnetz
// (für den Zugriff von außen einen Reverse-Proxy mit HTTPS davorschalten).
const useTls = Boolean(process.env.TLS_CERT && process.env.TLS_KEY);
const server = useTls
  ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, handleRequest)
  : http.createServer(handleRequest); // nosemgrep: problem-based-packs.insecure-transport.js-node.using-http-server.using-http-server

server.listen(PORT, HOST, () => {
  console.log(`🎧 Pop Radio läuft auf ${useTls ? 'https' : 'http'}://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
