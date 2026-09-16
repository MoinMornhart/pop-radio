#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  Pop Radio – Proxmox VE LXC Installer
#  Auf der Proxmox-Shell (Host) ausführen:
#    bash -c "$(curl -fsSL https://raw.githubusercontent.com/MoinMornhart/pop-radio/main/proxmox/pop-radio.sh)"
#
#  Ist Pop Radio schon installiert, aktualisiert derselbe Befehl den Container.
#
#  Anpassbar über Umgebungsvariablen, z. B.:
#    CTID=150 MEMORY=1024 BRIDGE=vmbr1 bash -c "$(curl -fsSL ...)"
#    MODE=install  → immer einen neuen Container anlegen
# ---------------------------------------------------------------------------
set -euo pipefail

APP="Pop Radio"
REPO_URL="${REPO_URL:-https://github.com/MoinMornhart/pop-radio.git}"
BRANCH="${BRANCH:-main}"

CT_HOSTNAME="${CT_HOSTNAME:-pop-radio}"
CORES="${CORES:-1}"
MEMORY="${MEMORY:-512}"
DISK="${DISK:-4}"
BRIDGE="${BRIDGE:-vmbr0}"
PORT="${PORT:-3000}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"

GN="\e[32m"; YW="\e[33m"; RD="\e[31m"; BL="\e[36m"; CL="\e[0m"
msg()  { echo -e " ${BL}➜${CL} $*"; }
ok()   { echo -e " ${GN}✔${CL} $*"; }
warn() { echo -e " ${YW}⚠${CL} $*"; }
fail() { echo -e " ${RD}✘ $*${CL}"; exit 1; }

cat <<'EOF'

   ____                ____            _ _
  |  _ \ ___  _ __    |  _ \ __ _  __| (_) ___
  | |_) / _ \| '_ \   | |_) / _` |/ _` | |/ _ \
  |  __/ (_) | |_) |  |  _ < (_| | (_| | | (_) |
  |_|   \___/| .__/   |_| \_\__,_|\__,_|_|\___/
             |_|        Proxmox LXC Installer

EOF

# ---------- Prüfungen ----------
command -v pct >/dev/null 2>&1 || fail "Dieses Skript muss auf einem Proxmox-VE-Host laufen."
[[ $EUID -eq 0 ]] || fail "Bitte als root ausführen."

# Pop Radio im Container installieren bzw. reparieren (Repo klonen, Installer aus dem Klon starten –
# nichts wird per curl | bash ausgeführt)
install_app() {
  local id="$1"
  msg "Installiere $APP im Container $id (dauert 1–2 Minuten) …"
  pct exec "$id" -- bash -c "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq git curl ca-certificates >/dev/null"
  pct exec "$id" -- bash -c "test -d /opt/pop-radio/.git || git clone -q --branch '$BRANCH' '$REPO_URL' /opt/pop-radio"
  pct exec "$id" -- env REPO_URL="$REPO_URL" BRANCH="$BRANCH" PORT="$PORT" bash /opt/pop-radio/scripts/install.sh
}

show_result() {
  local id="$1" ip port
  ip="$(pct exec "$id" -- hostname -I | awk '{print $1}')"
  port="$(pct exec "$id" -- systemctl show pop-radio -p Environment --value 2>/dev/null | tr ' ' '\n' | sed -n 's/^PORT=//p')"
  echo
  echo -e "   Öffne im Browser:  ${YW}http://${ip}:${port:-$PORT}${CL}"
  echo -e "   Update:            diesen Befehl erneut ausführen – oder ${YW}update${CL} in der Konsole von Container ${id}"
  echo
}

# ---------- Schon installiert? Dann aktualisieren ----------
if [[ "${MODE:-}" != "install" ]]; then
  EXISTING=()
  for id in $(pct list | awk 'NR>1 {print $1}'); do
    if grep -qi 'pop-radio' <<<"$(pct config "$id" 2>/dev/null)"; then EXISTING+=("$id"); fi
  done
  if [[ -n "${CTID:-}" ]]; then
    # Ausdrücklich gewählte ID: nur diese aktualisieren, falls es ein Pop-Radio-Container ist
    if [[ " ${EXISTING[*]} " == *" $CTID "* ]]; then EXISTING=("$CTID"); else EXISTING=(); fi
  fi

  if [[ ${#EXISTING[@]} -gt 0 ]]; then
    UPDATE_ID="${EXISTING[0]}"
    if [[ ${#EXISTING[@]} -gt 1 ]]; then
      warn "Mehrere Pop-Radio-Container: ${EXISTING[*]}. Einen anderen wählst du mit CTID=<ID>."
    fi
    echo -e "  $APP ist schon installiert in Container ${YW}${UPDATE_ID}${CL}."
    answer="j"
    if [[ -t 0 ]]; then
      read -r -p "  Jetzt aktualisieren? [J/n]  (n = zusätzlichen Container anlegen) " answer
    fi
    if [[ "${answer:-j}" =~ ^[JjYy]$ ]]; then
      if [[ "$(pct status "$UPDATE_ID" | awk '{print $2}')" != "running" ]]; then
        msg "Starte Container $UPDATE_ID …"
        pct start "$UPDATE_ID"
        sleep 5
      fi
      if pct exec "$UPDATE_ID" -- test -x /opt/pop-radio/scripts/update.sh; then
        pct exec "$UPDATE_ID" -- bash /opt/pop-radio/scripts/update.sh
      else
        warn "Installation im Container ist unvollständig – wird nachgeholt."
        install_app "$UPDATE_ID"
      fi
      ok "${GN}${APP} ist auf dem neuesten Stand.${CL}"
      show_result "$UPDATE_ID"
      exit 0
    fi
    unset CTID
  fi
fi

CTID="${CTID:-$(pvesh get /cluster/nextid)}"
if pct status "$CTID" >/dev/null 2>&1 || qm status "$CTID" >/dev/null 2>&1; then
  fail "Die ID $CTID ist schon vergeben. Wähle eine andere, z. B.: CTID=150 bash -c \"\$(curl …)\""
fi
if [[ -z "${STORAGE:-}" ]]; then
  if pvesm status -content rootdir 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "local-lvm"; then
    STORAGE="local-lvm"
  else
    STORAGE="$(pvesm status -content rootdir | awk 'NR>1 {print $1; exit}')"
  fi
fi
[[ -n "$STORAGE" ]] || fail "Kein Storage für Container gefunden."

echo -e "  Container-ID: ${YW}${CTID}${CL}   Hostname: ${YW}${CT_HOSTNAME}${CL}"
echo -e "  CPU: ${YW}${CORES}${CL}   RAM: ${YW}${MEMORY} MB${CL}   Disk: ${YW}${DISK} GB${CL} auf ${YW}${STORAGE}${CL}   Bridge: ${YW}${BRIDGE}${CL} (DHCP)"
echo
if [[ -t 0 ]]; then
  read -r -p "  Container mit diesen Einstellungen erstellen? [J/n] " answer
  [[ "${answer:-j}" =~ ^[JjYy]$ ]] || { echo "  Abgebrochen."; exit 0; }
fi

# ---------- Template ----------
ARCH="$(dpkg --print-architecture)" # amd64, arm64, …
msg "Suche Debian-Templates für ${ARCH} …"
pveam update >/dev/null || warn "Template-Liste konnte nicht aktualisiert werden, nutze die vorhandene."
# Neuestes Template je Debian-Version, neueste Version zuerst (z. B. 13, dann 12)
mapfile -t TEMPLATES < <(
  pveam available --section system | awk '{print $2}' \
    | grep -E "^debian-${OS_VERSION:-1[2-9]}-standard_.*_${ARCH}\.tar\.(zst|gz|xz)$" \
    | sort -V \
    | awk -F'[-_]' '{ latest[$2] = $0 } END { for (v in latest) print v, latest[v] }' \
    | sort -rn | awk '{print $2}'
)
[[ ${#TEMPLATES[@]} -gt 0 ]] || fail "Kein passendes Debian-Template für ${ARCH} gefunden."

# ---------- Container ----------
# Nur Container entfernen, die dieses Skript selbst angelegt hat (ID war vorher frei)
cleanup_ct() {
  pct stop "$CTID" >/dev/null 2>&1 || true
  pct destroy "$CTID" --purge >/dev/null 2>&1 || true
}

STARTED=""
for TEMPLATE in "${TEMPLATES[@]}"; do
  if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE"; then
    msg "Lade $TEMPLATE herunter …"
    pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" >/dev/null || { warn "Download fehlgeschlagen."; continue; }
  fi

  msg "Erstelle LXC-Container $CTID mit $TEMPLATE …"
  if ! pct create "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
    --hostname "$CT_HOSTNAME" \
    --arch "$ARCH" \
    --cores "$CORES" --memory "$MEMORY" --swap 256 \
    --rootfs "${STORAGE}:${DISK}" \
    --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp" \
    --unprivileged 1 --features nesting=1 \
    --onboot 1 --tags "radio" \
    --description "Pop Radio – ${REPO_URL%.git}" >/dev/null; then
    warn "Container konnte nicht erstellt werden."
    cleanup_ct
    continue
  fi

  if pct start "$CTID" >/dev/null 2>&1; then
    STARTED=1
    break
  fi
  warn "Container startet nicht. Letzte Zeilen aus dem Debug-Log:"
  pct start "$CTID" --debug 2>&1 | tail -n 20 | sed 's/^/     /' || true
  cleanup_ct
  if [[ "$TEMPLATE" != "${TEMPLATES[-1]}" ]]; then
    warn "Versuche es mit dem nächstälteren Debian …"
  fi
done
[[ -n "$STARTED" ]] || fail "Kein Container ließ sich starten. Bitte die Log-Zeilen oben in einem GitHub-Issue posten."
ok "Container gestartet ($TEMPLATE)"

trap 'echo -e " ${RD}✘ Abbruch in Zeile $LINENO.${CL} Container $CTID bleibt zur Fehlersuche bestehen (entfernen: pct destroy $CTID)."' ERR

msg "Warte auf Netzwerk …"
for _ in $(seq 1 30); do
  if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then break; fi
  sleep 2
done
pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 || fail "Container hat kein Internet."
ok "Netzwerk bereit"

# ---------- App installieren ----------
install_app "$CTID"
pct exec "$CTID" -- test -x /usr/bin/update || fail "Der Befehl 'update' fehlt im Container – Installation unvollständig."
echo
ok "${GN}${APP} ist fertig installiert!${CL}"
show_result "$CTID"
