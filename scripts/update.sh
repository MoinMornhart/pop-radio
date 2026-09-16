#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  Pop Radio – Update
#  Im Container einfach:   update
#  Vom Proxmox-Host aus:   den Installer-Einzeiler erneut ausführen
#                          oder: pct exec <CTID> -- bash /opt/pop-radio/scripts/update.sh
# ---------------------------------------------------------------------------
set -euo pipefail

# git reset ersetzt gleich diese Datei – daher aus einer Kopie weiterlaufen
if [[ -z "${POPRADIO_UPDATE_COPY:-}" ]]; then
  copy="$(mktemp)"
  cp "$0" "$copy"
  POPRADIO_UPDATE_COPY="$copy" exec bash "$copy" "$@"
fi
trap 'rm -f "$POPRADIO_UPDATE_COPY"' EXIT

APP_DIR="/opt/pop-radio"
GN="\e[32m"; YW="\e[33m"; BL="\e[36m"; CL="\e[0m"

[[ $EUID -eq 0 ]] || { echo "Bitte als root ausführen."; exit 1; }
[[ -d "$APP_DIR/.git" ]] || { echo "Keine Installation in $APP_DIR gefunden."; exit 1; }

cd "$APP_DIR"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
OLD="$(git rev-parse --short HEAD)"

echo -e " ${BL}➜${CL} Suche nach Updates …"
git fetch -q origin "$BRANCH"
NEW="$(git rev-parse --short "origin/$BRANCH")"

# Ist die Installation vollständig? (z. B. nach einem Abbruch beim ersten Einrichten)
installed() {
  command -v node >/dev/null 2>&1 && [[ -f /etc/systemd/system/pop-radio.service ]] && [[ -x /usr/bin/update ]]
}
current_port() {
  local port
  port="$(systemctl show pop-radio -p Environment --value 2>/dev/null | tr ' ' '\n' | sed -n 's/^PORT=//p')"
  echo "${port:-3000}"
}

if [[ "$OLD" == "$NEW" ]]; then
  if installed; then
    systemctl is-active -q pop-radio || systemctl restart pop-radio
    echo -e " ${GN}✔${CL} Pop Radio ist aktuell (${OLD})."
  else
    echo -e " ${BL}➜${CL} Installation ist unvollständig, richte neu ein …"
    PORT="$(current_port)" BRANCH="$BRANCH" bash scripts/install.sh
  fi
  exit 0
fi

echo -e " ${BL}➜${CL} Neue Änderungen:"
git --no-pager log --oneline "HEAD..origin/$BRANCH" | sed 's/^/     /'

git reset -q --hard "origin/$BRANCH"
chown -R popradio:popradio "$APP_DIR"

# Neuere Version des Updaters/Installers übernehmen (z. B. geänderter Dienst)
if ! installed || ! git diff --quiet "$OLD" "$NEW" -- scripts/install.sh; then
  echo -e " ${BL}➜${CL} Richte Pop Radio neu ein …"
  PORT="$(current_port)" BRANCH="$BRANCH" bash scripts/install.sh
else
  systemctl restart pop-radio
fi

echo -e " ${GN}✔${CL} Aktualisiert: ${YW}${OLD}${CL} → ${YW}${NEW}${CL}"
