#!/usr/bin/env bash
#
# install-tweenforge-lxc.sh
# Run ON THE PROXMOX HOST as root. Creates a Debian LXC, installs Node, clones
# Tweenforge from GitHub, builds it, and registers a systemd service that
# auto-starts on boot. Nothing to copy — it pulls the code itself.
#
set -euo pipefail

# ============================= CONFIG =============================
REPO="https://github.com/rpoltera/Tweenforge.git"
HOSTNAME="tweenforge"
TEMPLATE="local:vztmpl/debian-13-standard_13.0-1_amd64.tar.zst"  # adjust if yours differs
STORAGE="local-lvm"    # where the container disk lives
BRIDGE="vmbr0"         # network bridge
DISK_GB=8
CORES=2
MEMORY_MB=2048
SWAP_MB=512
PORT=5173
APP_PATH="/opt/tweenforge"
# ==================================================================

command -v pct >/dev/null || { echo "ERROR: pct not found. Run this on the Proxmox host."; exit 1; }

CTID=$(pvesh get /cluster/nextid)
echo ">> Next free container ID: ${CTID}"

echo ">> Creating container ${CTID}..."
pct create "${CTID}" "${TEMPLATE}" \
  --hostname "${HOSTNAME}" \
  --cores "${CORES}" --memory "${MEMORY_MB}" --swap "${SWAP_MB}" \
  --rootfs "${STORAGE}:${DISK_GB}" \
  --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp" \
  --unprivileged 1 --features nesting=1 \
  --onboot 1

pct start "${CTID}"

echo ">> Waiting for container network..."
for i in $(seq 1 30); do
  if pct exec "${CTID}" -- getent hosts github.com >/dev/null 2>&1; then break; fi
  sleep 2
done

echo ">> Installing Node.js 22 + git..."
pct exec "${CTID}" -- bash -c "apt-get update -qq && apt-get install -y -qq curl git ca-certificates >/dev/null"
pct exec "${CTID}" -- bash -c "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null"
pct exec "${CTID}" -- bash -c "apt-get install -y -qq nodejs >/dev/null"
echo ">> Node version: $(pct exec "${CTID}" -- node -v)"

echo ">> Cloning ${REPO}..."
pct exec "${CTID}" -- git clone --depth 1 "${REPO}" "${APP_PATH}"

echo ">> Installing dependencies and building (takes a minute)..."
pct exec "${CTID}" -- bash -c "cd ${APP_PATH} && npm install --no-fund --no-audit && npm run build && npm install -g serve >/dev/null"

echo ">> Installing systemd service..."
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
echo " Tweenforge is installed and running."
echo " Container ID : ${CTID}"
echo " URL          : http://${IP}:${PORT}"
echo " Update later : pct exec ${CTID} -- bash -c 'cd ${APP_PATH} && git pull && npm install && npm run build' && pct exec ${CTID} -- systemctl restart tweenforge"
echo "======================================================"
