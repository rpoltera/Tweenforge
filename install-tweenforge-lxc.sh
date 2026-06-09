#!/usr/bin/env bash
#
# install-tweenforge-lxc.sh
# Run ON THE PROXMOX HOST as root. Auto-detects storage, template, and bridge,
# creates a Debian LXC, installs Node, clones Tweenforge, builds it, and starts
# it as a systemd service. No editing required — just run it.
#
set -euo pipefail

# ---- app settings (safe defaults) ----
REPO="https://github.com/rpoltera/Tweenforge.git"
HOSTNAME="tweenforge"
CORES=2
MEMORY_MB=2048
SWAP_MB=512
DISK_GB=8
PORT=5173
APP_PATH="/opt/tweenforge"

command -v pct >/dev/null || { echo "ERROR: pct not found. Run this on the Proxmox host."; exit 1; }

# ---- auto-detect storage that holds container disks ----
STORAGE=$(pvesm status -content rootdir 2>/dev/null | awk 'NR>1{print $1; exit}')
[ -n "${STORAGE:-}" ] || { echo "ERROR: no storage supports container disks (content 'rootdir'). Enable it on a storage in the GUI."; exit 1; }
echo ">> Storage: ${STORAGE}"

# ---- auto-detect storage that holds templates ----
TMPL_STORE=$(pvesm status -content vztmpl 2>/dev/null | awk 'NR>1{print $1; exit}')
TMPL_STORE="${TMPL_STORE:-local}"

# ---- find or download a Debian template ----
TEMPLATE=$(pveam list "${TMPL_STORE}" 2>/dev/null | awk '/debian-1[0-9]-standard/{print $1; exit}')
if [ -z "${TEMPLATE:-}" ]; then
  echo ">> No Debian template found — downloading..."
  pveam update >/dev/null 2>&1 || true
  TMPL_NAME=$(pveam available --section system 2>/dev/null | awk '/debian-1[0-9]-standard/{print $2}' | sort -V | tail -1)
  [ -n "${TMPL_NAME:-}" ] || { echo "ERROR: no Debian template available to download."; exit 1; }
  pveam download "${TMPL_STORE}" "${TMPL_NAME}"
  TEMPLATE="${TMPL_STORE}:vztmpl/${TMPL_NAME}"
fi
echo ">> Template: ${TEMPLATE}"

# ---- auto-detect a network bridge ----
BRIDGE=$(ls /sys/class/net 2>/dev/null | grep -m1 '^vmbr' || echo vmbr0)
echo ">> Bridge: ${BRIDGE}"

# ---- next free container id ----
CTID=$(pvesh get /cluster/nextid)
echo ">> Container ID: ${CTID}"

# ---- create + start ----
pct create "${CTID}" "${TEMPLATE}" \
  --hostname "${HOSTNAME}" \
  --cores "${CORES}" --memory "${MEMORY_MB}" --swap "${SWAP_MB}" \
  --rootfs "${STORAGE}:${DISK_GB}" \
  --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp" \
  --unprivileged 1 --features nesting=1 --onboot 1
pct start "${CTID}"

# ---- wait for network ----
echo ">> Waiting for network..."
for i in $(seq 1 30); do
  pct exec "${CTID}" -- getent hosts github.com >/dev/null 2>&1 && break
  sleep 2
done

# ---- node + git ----
echo ">> Installing Node.js 22 + git..."
pct exec "${CTID}" -- bash -c "apt-get update -qq && apt-get install -y -qq curl git ca-certificates >/dev/null"
pct exec "${CTID}" -- bash -c "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null"
pct exec "${CTID}" -- bash -c "apt-get install -y -qq nodejs >/dev/null"

# ---- clone + build ----
echo ">> Cloning and building..."
pct exec "${CTID}" -- git clone --depth 1 "${REPO}" "${APP_PATH}"
pct exec "${CTID}" -- bash -c "cd ${APP_PATH} && npm install --no-fund --no-audit && npm run build && npm install -g serve >/dev/null"

# ---- systemd service ----
cat > /tmp/tweenforge.service <<UNIT
[Unit]
Description=Tweenforge
After=network.target

[Service]
WorkingDirectory=${APP_PATH}
ExecStart=/usr/bin/env serve -s dist -l ${PORT}
Restart=always

[Install]
WantedBy=multi-user.target
UNIT
pct push "${CTID}" /tmp/tweenforge.service /etc/systemd/system/tweenforge.service
rm -f /tmp/tweenforge.service
pct exec "${CTID}" -- systemctl daemon-reload
pct exec "${CTID}" -- systemctl enable --now tweenforge

IP=$(pct exec "${CTID}" -- bash -c "hostname -I | awk '{print \$1}'")
echo ""
echo "======================================================"
echo " Tweenforge is running."
echo " Container ID : ${CTID}"
echo " URL          : http://${IP}:${PORT}"
echo "======================================================"
