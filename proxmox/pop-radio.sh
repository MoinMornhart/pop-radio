#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  Pop Radio – Proxmox VE LXC Installer
#  Auf der Proxmox-Shell (Host) ausführen:
#    bash -c "$(curl -fsSL https://raw.githubusercontent.com/MoinMornhart/pop-radio/main/proxmox/pop-radio.sh)"
#
#  Anpassbar über Umgebungsvariablen, z. B.:
#    CTID=150 MEMORY=1024 BRIDGE=vmbr1 bash -c "$(curl -fsSL ...)"
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
msg "Installiere $APP im Container (dauert 1–2 Minuten) …"
pct exec "$CTID" -- bash -c "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq git curl ca-certificates >/dev/null"
# Repo klonen und den Installer aus dem Klon starten (nichts wird per curl | bash ausgeführt)
pct exec "$CTID" -- git clone -q --branch "$BRANCH" "$REPO_URL" /opt/pop-radio
pct exec "$CTID" -- env REPO_URL="$REPO_URL" BRANCH="$BRANCH" PORT="$PORT" bash /opt/pop-radio/scripts/install.sh

IP="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"
echo
ok "${GN}${APP} ist fertig installiert!${CL}"
echo -e "   Öffne im Browser:  ${YW}http://${IP}:${PORT}${CL}"
echo -e "   Update:            ${YW}pct exec ${CTID} -- update${CL}   (oder 'update' in der Container-Konsole)"
echo
