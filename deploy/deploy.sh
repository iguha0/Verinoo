#!/usr/bin/env bash
# Run this ON the VPS to pull, rebuild and restart the public network.
# Assumes the layout from deploy/README.md was followed once already.
set -euo pipefail

APP=/opt/ainative
WWW=/var/www/ainative
NODES=(node1 node2 node3)

cd "$APP"
echo "==> pulling latest main"
git pull --ff-only

echo "==> installing deps + building"
npm ci >/dev/null
npm run build

echo "==> native prover (no-op if vendored)"
node scripts/setup-rapidsnark.mjs || echo "    (rapidsnark skipped — snarkjs fallback stays active)"

echo "==> restarting nodes: ${NODES[*]}"
for n in "${NODES[@]}"; do
  sudo systemctl restart "ainative@$n"
done

echo "==> refreshing landing site"
sudo mkdir -p "$WWW"
sudo rsync -a --delete website/ "$WWW/"

echo "==> nginx check + reload"
sudo nginx -t && sudo systemctl reload nginx

sleep 2
echo "==> health:"
for p in 3001 3002 3003; do
  curl -s --max-time 5 "http://127.0.0.1:$p/status" | head -c 160; echo
done

echo "==> public check (via nginx):"
curl -s -o /dev/null -w "site     HTTP %{http_code}\n" http://127.0.0.1/
curl -s -o /dev/null -w "api      HTTP %{http_code}\n" http://127.0.0.1/status
