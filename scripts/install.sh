#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  Pop Radio – Installation auf Debian/Ubuntu (im LXC oder auf einem Server)
#    curl -fsSL https://raw.githubusercontent.com/MoinMornhart/pop-radio/main/scripts/install.sh | bash
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/MoinMornhart/pop-radio.git}"
BRANCH="${BRANCH:-main}"
PORT="${PORT:-3000}"
APP_DIR="/opt/pop-radio"
APP_USER="popradio"
export DEBIAN_FRONTEND=noninteractive

GN="\e[32m"; BL="\e[36m"; CL="\e[0m"
msg() { echo -e " ${BL}➜${CL} $*"; }
ok()  { echo -e " ${GN}✔${CL} $*"; }

[[ $EUID -eq 0 ]] || { echo "Bitte als root ausführen."; exit 1; }

msg "Installiere Pakete …"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates >/dev/null

node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' || echo 0; }
if [[ "$(node_major)" -lt 18 ]]; then
  apt-get install -y -qq nodejs >/dev/null 2>&1 || true
fi
if [[ "$(node_major)" -lt 18 ]]; then
  # NodeSource als signierte apt-Quelle einrichten (statt fremdes Skript per curl | bash auszuführen)
  msg "Installiere Node.js 22 über NodeSource …"
  apt-get install -y -qq gnupg >/dev/null
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" >/etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
fi
ok "Node.js $(node -v)"

id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

if [[ -d "$APP_DIR/.git" ]]; then
  msg "Vorhandene Installation gefunden, aktualisiere …"
  git -C "$APP_DIR" fetch -q origin "$BRANCH"
  git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
else
  msg "Lade Pop Radio herunter …"
  git clone -q --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
git config --system --get-all safe.directory 2>/dev/null | grep -qx "$APP_DIR" || git config --system --add safe.directory "$APP_DIR"
ok "Code liegt in $APP_DIR"

msg "Richte Dienst ein …"
cat >/etc/systemd/system/pop-radio.service <<EOF
[Unit]
Description=Pop Radio
After=network-online.target
Wants=network-online.target

[Service]
User=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=HOST=0.0.0.0
Environment=PORT=${PORT}
ExecStart=/usr/bin/env node server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q --now pop-radio
systemctl restart pop-radio

# "update"-Befehl wie bei den Community-Scripts
cat >/usr/local/bin/update <<'EOF'
#!/usr/bin/env bash
exec bash /opt/pop-radio/scripts/update.sh "$@"
EOF
chmod +x /usr/local/bin/update

cat >/etc/motd <<EOF

  📻 Pop Radio
     Web:     http://$(hostname -I | awk '{print $1}'):${PORT}
     Update:  update
     Logs:    journalctl -u pop-radio -f

EOF

ok "Dienst läuft (Port ${PORT})"
