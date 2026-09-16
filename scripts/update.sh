#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  Pop Radio – Update
#  Im Container einfach:   update
#  Vom Proxmox-Host aus:   pct exec <CTID> -- update
# ---------------------------------------------------------------------------
set -euo pipefail

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

if [[ "$OLD" == "$NEW" ]]; then
  echo -e " ${GN}✔${CL} Pop Radio ist aktuell (${OLD})."
  exit 0
fi

echo -e " ${BL}➜${CL} Neue Änderungen:"
git --no-pager log --oneline "HEAD..origin/$BRANCH" | sed 's/^/     /'

git reset -q --hard "origin/$BRANCH"
chown -R popradio:popradio "$APP_DIR"

# Neuere Version des Updaters/Installers übernehmen (z. B. geänderter Dienst)
if ! git diff --quiet "$OLD" "$NEW" -- scripts/install.sh; then
  echo -e " ${BL}➜${CL} Installer hat sich geändert, richte neu ein …"
  PORT="$(systemctl show pop-radio -p Environment --value | tr ' ' '\n' | sed -n 's/^PORT=//p')"
  PORT="${PORT:-3000}" BRANCH="$BRANCH" bash scripts/install.sh
else
  systemctl restart pop-radio
fi

echo -e " ${GN}✔${CL} Aktualisiert: ${YW}${OLD}${CL} → ${YW}${NEW}${CL}"
