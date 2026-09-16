# 📻 Pop Radio

Such deinen Sender auf [radio.de](https://www.radio.de) und füge die Adresse ein, zum Beispiel `https://www.radio.de/s/1live`. Pop Radio öffnet dann ein Popup mit:

- 🎵 **dem Song, der gerade läuft**, samt Cover, Verlauf und optionaler Benachrichtigung bei Songwechsel
- 📰 **den neuesten News** des Senders (RSS-Feed oder Schlagzeilen von der Website)
- ▶ **einem Player**, mit dem du den Sender direkt hören kannst

Die Popups lassen sich verschieben oder mit `↗` als eigenes Mini-Fenster öffnen. Bei Sendern mit mehreren Streams kannst du den Kanal wählen.

Auch Links von radio.net, radio.at, radio.fr, radio.it, radio.es, radio.pt, radio.pl, radio.dk und radio.se funktionieren. Die Website eines Senders (z. B. `fm4.orf.at`) geht als Notlösung ebenfalls.

---

## 🚀 Quickstart: Proxmox VE

Führe diesen Befehl in der **Proxmox-Shell** aus (Host → Shell):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/MoinMornhart/pop-radio/main/proxmox/pop-radio.sh)"
```

Das Skript erstellt einen schlanken Debian-LXC-Container (1 CPU, 512 MB RAM, 4 GB Disk, DHCP) und installiert Pop Radio darin. Am Ende zeigt es die Adresse an, zum Beispiel `http://192.168.1.50:3000`.

### 🔄 Update

In der Konsole des Containers:

```bash
update
```

Oder direkt vom Proxmox-Host aus (`<CTID>` durch die Container-ID ersetzen):

```bash
pct exec <CTID> -- update
```

### ⚙️ Eigene Einstellungen (optional)

Stell die Werte einfach vor den Befehl:

```bash
CTID=150 MEMORY=1024 BRIDGE=vmbr1 PORT=8080 bash -c "$(curl -fsSL https://raw.githubusercontent.com/MoinMornhart/pop-radio/main/proxmox/pop-radio.sh)"
```

| Variable           | Standard           | Bedeutung                       |
| ------------------ | ------------------ | ------------------------------- |
| `CTID`             | nächste freie ID   | Container-ID                    |
| `CT_HOSTNAME`      | `pop-radio`        | Hostname                        |
| `CORES`            | `1`                | CPU-Kerne                       |
| `MEMORY`           | `512`              | RAM in MB                       |
| `DISK`             | `4`                | Festplatte in GB                |
| `STORAGE`          | `local-lvm`\*      | Storage für den Container       |
| `TEMPLATE_STORAGE` | `local`            | Storage für das Debian-Template |
| `OS_VERSION`       | neueste (13 → 12)  | Debian-Version, z. B. `12`      |
| `BRIDGE`           | `vmbr0`            | Netzwerk-Bridge                 |
| `PORT`             | `3000`             | Port der Weboberfläche          |

\* Gibt es `local-lvm` nicht, nimmt das Skript den ersten passenden Storage.

### 🛠 Nützliche Befehle im Container

```bash
systemctl status pop-radio     # Status
journalctl -u pop-radio -f     # Live-Logs
systemctl restart pop-radio    # Neustart
```

---

## 🐧 Installation auf einem anderen Debian/Ubuntu-Server

```bash
curl -fsSL https://raw.githubusercontent.com/MoinMornhart/pop-radio/main/scripts/install.sh | sudo bash
```

Aktualisieren kannst du danach ebenfalls mit `sudo update`.

## 💻 Lokal starten (Windows, macOS, Linux)

Du brauchst nur [Node.js](https://nodejs.org) ab Version 18. Weitere Abhängigkeiten gibt es nicht.

```bash
git clone https://github.com/MoinMornhart/pop-radio.git
cd pop-radio
npm start
```

Dann im Browser [http://localhost:3000](http://localhost:3000) öffnen.

---

## Wie funktioniert das?

Browser dürfen fremde Websites nicht direkt auslesen (CORS). Deshalb erledigt das ein kleiner Node-Server:

1. **Sender erkennen:** Aus dem radio.de-Link liest der Server die Sender-ID und holt über die radio.de-Schnittstelle Name, Logo, Streams und die Homepage des Senders. Bei einer normalen Sender-Website sucht er stattdessen bei [radio-browser.info](https://www.radio-browser.info) und im Seitenquelltext nach Streams.
2. **Was läuft gerade?** Den Songtitel liefert radio.de. Kennt radio.de ihn nicht, verbindet sich der Server kurz mit dem Audiostream und liest die ICY-Metadaten (`StreamTitle`) aus. Das Cover kommt von der iTunes-Suche.
3. **News:** Er sucht RSS-/Atom-Feeds auf der Homepage des Senders. Gibt es keine, nimmt er die Schlagzeilen von der Startseite.

**Grenzen:** Manche Sender (z. B. Antenne Bayern) laden ihre News nur per JavaScript nach. Dann zeigt das Popup keine News an. Die radio.de-Schnittstelle ist nicht offiziell dokumentiert und kann sich jederzeit ändern.

**HTTPS (optional):** Setzt du `TLS_CERT` und `TLS_KEY` auf die Pfade zu Zertifikat und Schlüssel, läuft der Server über HTTPS. Im LXC trägst du die beiden Werte als `Environment=` in `/etc/systemd/system/pop-radio.service` ein. Alternativ schaltest du einen Reverse-Proxy davor.

> ⚠️ Der Server ruft beliebige URLs ab, die man ihm gibt. Betreibe ihn nur in deinem Heimnetz und stell ihn nicht offen ins Internet.

## Projektstruktur

```
server.js              Node-Server (API + statische Dateien)
public/                Weboberfläche (HTML, CSS, JS)
proxmox/pop-radio.sh   Proxmox-Installer (erstellt den LXC)
scripts/install.sh     Installation im Container / auf Debian
scripts/update.sh      Update-Befehl
```
