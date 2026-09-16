// Pop Radio – Frontend

const STORAGE_KEY = 'popradio.stations';
const NOWPLAYING_INTERVAL = 20_000;
const NEWS_INTERVAL = 5 * 60_000;

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

async function api(path, params) {
  const res = await fetch(`${path}?${new URLSearchParams(params)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

function loadStations() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; }
}
function saveStations(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch {}
}

const rtf = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });
function timeAgo(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  const sec = (d - Date.now()) / 1000;
  const units = [['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, s] of units) if (Math.abs(sec) >= s) return rtf.format(Math.round(sec / s), unit);
  return 'gerade eben';
}
const clock = (d) => d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

function logoImg(src, cls = 'logo-img') {
  const img = h('img', { class: cls, src: src || '', alt: '', loading: 'lazy' });
  img.onerror = () => { img.src = 'data:image/svg+xml,' + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='#221e31'/><text x='50' y='66' font-size='50' text-anchor='middle'>📻</text></svg>"); };
  return img;
}

// Cover über die iTunes-Suche (erlaubt Browser-Anfragen)
const coverCache = new Map();
async function findCover(artist, song) {
  if (!artist || !song) return null;
  const key = `${artist}|${song}`.toLowerCase();
  if (coverCache.has(key)) return coverCache.get(key);
  try {
    const term = `${artist} ${song}`.replace(/\(.*?\)|feat\..*/gi, '').trim();
    const res = await fetch(`https://itunes.apple.com/search?${new URLSearchParams({ term, entity: 'song', limit: 1, country: 'DE' })}`);
    const data = await res.json();
    const url = data.results?.[0]?.artworkUrl100?.replace('100x100', '600x600') || null;
    coverCache.set(key, url);
    return url;
  } catch {
    return null;
  }
}

// ---------- Popup ----------

let popupCount = 0;

function createPopup(input, { windowed = false } = {}) {
  let station = null;
  let channelIdx = 0;
  let tab = 'music';
  let lastTitle = null;
  let notify = false;
  const history = [];
  const timers = [];
  const audio = new Audio();
  audio.preload = 'none';

  const statusEl = h('span', { class: 'off' }, 'Lädt …');
  const nameEl = h('strong', {}, input);
  const logoEl = logoImg('');
  const bodyEl = h('div', { class: 'popup-body' }, h('div', { class: 'spinner' }));
  const channelSelect = h('select', { hidden: true, 'aria-label': 'Kanal', onchange: (e) => { channelIdx = +e.target.value; switchChannel(); } });
  const musicTab = h('button', { class: 'active', onclick: () => setTab('music') }, '🎵 Musik');
  const newsTab = h('button', { onclick: () => setTab('news') }, '📰 News');

  const musicView = h('div');
  const newsView = h('div', { class: 'news', hidden: true });

  const bellBtn = h('button', { class: 'icon-btn', title: 'Bei Songwechsel benachrichtigen', onclick: toggleNotify }, '🔔');
  const winBtn = !windowed && h('button', { class: 'icon-btn', title: 'Als eigenes Fenster öffnen', onclick: openWindow }, '↗');
  const closeBtn = !windowed && h('button', { class: 'icon-btn', title: 'Schließen', onclick: close }, '✕');

  const head = h('div', { class: 'popup-head' }, logoEl, h('div', { class: 'title' }, nameEl, statusEl), bellBtn, winBtn, closeBtn);
  const el = h('div', { class: 'popup' + (windowed ? ' windowed' : '') },
    head, channelSelect, h('div', { class: 'tabs' }, musicTab, newsTab), bodyEl);

  if (windowed) {
    document.body.replaceChildren(el);
  } else {
    const offset = (popupCount++ % 6) * 28;
    el.style.left = `${Math.max(12, window.innerWidth - 390 - offset)}px`;
    el.style.top = `${Math.max(12, 80 + offset)}px`;
    el.addEventListener('pointerdown', () => { el.style.zIndex = ++popupCount + 10; });
    makeDraggable(el, head);
    $('#popups').append(el);
  }

  function setTab(t) {
    tab = t;
    musicTab.classList.toggle('active', t === 'music');
    newsTab.classList.toggle('active', t === 'news');
    musicView.hidden = t !== 'music';
    newsView.hidden = t !== 'news';
  }

  function toggleNotify() {
    if (!notify && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then((p) => { if (p === 'granted') toggleNotify(); });
      return;
    }
    if ('Notification' in window && Notification.permission !== 'granted') {
      alert('Benachrichtigungen sind im Browser blockiert.');
      return;
    }
    notify = !notify;
    bellBtn.classList.toggle('on', notify);
  }

  function openWindow() {
    window.open(`?popup=${encodeURIComponent(input)}&ch=${channelIdx}`, '_blank', 'popup,width=400,height=680');
    close();
  }

  function close() {
    timers.forEach(clearInterval);
    audio.pause();
    audio.src = '';
    el.remove();
  }

  // ----- Musik -----
  const coverEl = h('div', { class: 'cover' }, '🎶');
  const songEl = h('p', { class: 'song' }, '…');
  const artistEl = h('p', { class: 'artist' });
  const metaEl = h('div', { class: 'meta' });
  const playBtn = h('button', { class: 'play-btn', title: 'Abspielen', onclick: togglePlay }, '▶');
  const volume = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0.8, 'aria-label': 'Lautstärke', oninput: (e) => { audio.volume = e.target.value; } });
  const historyList = h('ol');
  const historyBox = h('div', { class: 'history', hidden: true }, h('h4', {}, 'Zuletzt gespielt'), historyList);

  musicView.append(
    h('div', { class: 'now' }, coverEl, songEl, artistEl, metaEl, h('div', { class: 'player' }, playBtn, volume)),
    historyBox,
  );

  function togglePlay() {
    const ch = station?.channels[channelIdx];
    if (!ch) return;
    if (audio.paused) {
      if (!audio.src) audio.src = ch.stream;
      audio.volume = volume.value;
      audio.play().catch(() => { metaEl.textContent = 'Stream konnte nicht abgespielt werden.'; });
    } else {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
  }
  audio.addEventListener('playing', () => { playBtn.textContent = '❚❚'; });
  audio.addEventListener('pause', () => { playBtn.textContent = '▶'; });

  function setCover(url) {
    if (url) {
      const img = h('img', { class: 'cover', src: url, alt: '' });
      coverEl.replaceWith(img);
      coverEl.__current = img;
    }
  }
  function resetCover() {
    const current = coverEl.__current;
    if (current) { current.replaceWith(coverEl); coverEl.__current = null; }
  }

  async function updateNowPlaying() {
    const ch = station?.channels[channelIdx];
    if (!ch) return;
    try {
      const np = await api('/api/nowplaying', { stream: ch.stream, name: ch.name });
      if (station?.channels[channelIdx] !== ch) return; // Kanal inzwischen gewechselt
      if (!np.ok) {
        setLive(false, 'Stream nicht erreichbar');
        return;
      }
      setLive(true);
      metaEl.textContent = [np.show || np.stationName, np.genre, np.bitrate && `${np.bitrate} kbit/s`].filter(Boolean).join(' · ');
      if (!np.streamTitle) {
        songEl.textContent = 'Keine Titelinfo im Stream';
        artistEl.textContent = 'Der Sender verrät leider nicht, was gerade läuft.';
        return;
      }
      if (np.streamTitle === lastTitle) return;
      if (!np.isSong) {
        resetCover();
        songEl.textContent = np.streamTitle;
        artistEl.textContent = 'Gerade kein Song: Moderation, Werbung oder Nachrichten';
        return;
      }
      const firstUpdate = lastTitle === null;
      if (lastTitle) {
        history.unshift({ title: lastTitle, time: new Date() });
        history.length = Math.min(history.length, 10);
        renderHistory();
      }
      lastTitle = np.streamTitle;
      songEl.textContent = np.song;
      artistEl.textContent = np.artist;
      resetCover();
      setCover(await findCover(np.artist, np.song));
      if (notify && !firstUpdate) {
        new Notification(np.song || np.streamTitle, { body: `${np.artist || ''}\n${station.name}`, icon: station.logo });
      }
    } catch {
      setLive(false, 'Keine Verbindung zum Server');
    }
  }

  function renderHistory() {
    historyBox.hidden = !history.length;
    historyList.replaceChildren(...history.map((e) => h('li', {}, h('span', {}, e.title), h('time', {}, clock(e.time)))));
  }

  function setLive(on, text) {
    statusEl.className = on ? '' : 'off';
    statusEl.replaceChildren(on ? 'Live' : text);
  }

  // ----- News -----
  async function updateNews() {
    if (!station) return;
    const feed = station.feeds[0];
    let items = station.headlines;
    let source = 'Schlagzeilen von der Website';
    if (feed) {
      try {
        const data = await api('/api/news', { feed });
        items = data.items;
        source = data.feedTitle || 'RSS-Feed';
      } catch {
        items = [];
      }
    }
    if (!items.length) {
      newsView.replaceChildren(h('p', { class: 'placeholder' }, 'Für diesen Sender wurden keine News gefunden.'));
      return;
    }
    newsView.replaceChildren(
      h('h4', { style: 'margin-top:0' }, source),
      ...items.map((n) => h('a', { class: 'news-item', href: n.link, target: '_blank', rel: 'noopener' },
        n.image && h('img', { src: n.image, alt: '', loading: 'lazy' }),
        h('div', {},
          n.date && h('time', {}, timeAgo(n.date)),
          h('div', { class: 'news-title' }, n.title),
          n.summary && h('p', {}, n.summary),
        ),
      )),
    );
  }

  function switchChannel() {
    lastTitle = null;
    history.length = 0;
    renderHistory();
    resetCover();
    songEl.textContent = '…';
    artistEl.textContent = '';
    const wasPlaying = !audio.paused;
    audio.pause();
    audio.removeAttribute('src');
    if (wasPlaying) togglePlay();
    updateNowPlaying();
  }

  // ----- Start -----
  (async () => {
    try {
      station = await api('/api/station', { url: input });
    } catch (e) {
      bodyEl.replaceChildren(h('p', { class: 'placeholder' }, `Sender konnte nicht geladen werden: ${e.message}`));
      setLive(false, 'Fehler');
      return;
    }
    nameEl.textContent = station.name;
    logoEl.src = station.logo;
    if (windowed) document.title = `${station.name} – Pop Radio`;
    bodyEl.replaceChildren(musicView, newsView);

    if (station.channels.length > 1) {
      channelSelect.hidden = false;
      channelSelect.replaceChildren(...station.channels.map((c, i) => h('option', { value: i }, c.name)));
      const wanted = +new URLSearchParams(location.search).get('ch');
      if (windowed && wanted < station.channels.length) { channelIdx = wanted; channelSelect.value = wanted; }
    }

    if (station.channels.length) {
      updateNowPlaying();
      timers.push(setInterval(updateNowPlaying, NOWPLAYING_INTERVAL));
    } else {
      setLive(false, 'Kein Stream gefunden');
      musicView.replaceChildren(h('p', { class: 'placeholder' }, 'Für diese Website wurde kein Audiostream gefunden, deshalb gibt es hier keine Musikinfos. Die News findest du im anderen Tab.'));
      setTab('news');
    }
    updateNews();
    timers.push(setInterval(updateNews, NEWS_INTERVAL));
  })();

  return el;
}

function makeDraggable(el, handle) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || window.innerWidth <= 600) return;
    const startX = e.clientX - el.offsetLeft;
    const startY = e.clientY - el.offsetTop;
    handle.setPointerCapture(e.pointerId);
    handle.style.cursor = 'grabbing';
    const move = (ev) => {
      el.style.left = `${Math.min(Math.max(0, ev.clientX - startX), window.innerWidth - 80)}px`;
      el.style.top = `${Math.min(Math.max(0, ev.clientY - startY), window.innerHeight - 50)}px`;
    };
    const up = () => {
      handle.style.cursor = '';
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

// ---------- Startseite ----------

function renderStations() {
  const list = loadStations();
  $('#empty').hidden = list.length > 0;
  $('#stations').replaceChildren(...list.map((s) => h('article', { class: 'station-card' },
    h('div', { class: 'top' },
      logoImg(s.logo),
      h('div', {}, h('h3', {}, s.name), h('small', {}, s.host)),
    ),
    s.description && h('p', { class: 'desc' }, s.description),
    h('small', {}, `${s.channels} Stream${s.channels === 1 ? '' : 's'} · ${s.hasNews ? 'News verfügbar' : 'keine News'}`),
    h('div', { class: 'actions' },
      h('button', { class: 'btn-primary', onclick: () => createPopup(s.input) }, 'Popup öffnen'),
      h('a', { class: 'icon-btn', href: s.homepage, target: '_blank', rel: 'noopener', title: 'Website öffnen' }, '🌐'),
      h('button', { class: 'icon-btn', title: 'Entfernen', onclick: () => removeStation(s.input) }, '🗑'),
    ),
  )));
}

function removeStation(input) {
  saveStations(loadStations().filter((s) => s.input !== input));
  renderStations();
}

async function addStation(raw) {
  const input = raw.trim();
  if (!input) return;
  const status = $('#status');
  const btn = $('#add-btn');
  status.className = 'hint';
  status.textContent = 'Suche Sender, Stream und News …';
  btn.disabled = true;
  try {
    const st = await api('/api/station', { url: input });
    const list = loadStations().filter((s) => s.homepage !== st.homepage);
    list.unshift({
      input,
      name: st.name,
      host: st.host,
      homepage: st.homepage,
      logo: st.logo,
      description: st.description,
      channels: st.channels.length,
      hasNews: st.feeds.length > 0 || st.headlines.length > 0,
    });
    saveStations(list);
    renderStations();
    $('#url-input').value = '';
    status.textContent = `✓ ${st.name} hinzugefügt: ${st.channels.length} Stream(s), ${st.feeds.length ? 'RSS-News' : st.headlines.length ? 'Schlagzeilen' : 'keine News'}`;
    createPopup(input);
  } catch (e) {
    status.className = 'hint error';
    status.textContent = `Das hat nicht geklappt: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------- Init ----------

const popupParam = new URLSearchParams(location.search).get('popup');
if (popupParam) {
  createPopup(popupParam, { windowed: true });
} else {
  renderStations();
  $('#add-form').addEventListener('submit', (e) => { e.preventDefault(); addStation($('#url-input').value); });
  $('#url-input').addEventListener('paste', () => setTimeout(() => addStation($('#url-input').value), 0));
  document.querySelectorAll('[data-example]').forEach((b) => b.addEventListener('click', () => addStation(b.dataset.example)));
}
