# Deploying a public 3-node network on one VPS

Target layout: one small VPS (1–2 GB RAM is enough — nodes are light; proving
bursts want more), three systemd-managed nodes, nginx serving the landing site
statically and proxying chain API + dashboard to the validator. TLS via certbot.

```
internet ──▶ nginx :80/:443
              ├─ /            → static website/ (survives node restarts)
              └─ /status,/tx… → 127.0.0.1:3001 (validator node)
node1 :3001/:5001 (validator) ─┐
node2 :3002/:5002 (peer)       ├─ gossip over loopback
node3 :3003/:5003 (peer)     ──┘
```

## One-time setup

```bash
# 1. user + code
sudo adduser --system --group ainative
sudo mkdir -p /opt/ainative /var/lib/ainative /etc/ainative /var/www/ainative
sudo chown -R ainative:ainative /opt/ainative /var/lib/ainative
sudo git clone https://github.com/indrajitguha/ai_chain_network /opt/ainative
sudo chown -R ainative:ainative /opt/ainative
cd /opt/ainative

# 2. build — Node.js >= 22.13 required (node:sqlite); Node 24 LTS recommended.
#    devDependencies are required for tsc.
sudo -u ainative npm ci && sudo -u ainative npm run build
sudo -u ainative npm run setup:rapidsnark || true   # optional native prover

# 3. per-node env files
sudo cp deploy/ainative.env.example /tmp/envs
for n in node1 node2 node3; do
  sudo sed -n "/$n.env/,/^$/p" /tmp/envs | grep '^AIN_' \
    | sudo tee /etc/ainative/$n.env > /dev/null
done
sudo sed -i 's/^# //' /etc/ainative/node2.env /etc/ainative/node3.env
sudo chown -R root:ainative /etc/ainative && sudo chmod 640 /etc/ainative/*.env

# 4. systemd
sudo cp deploy/ainative@.service /etc/systemd/system/
for n in node1 node2 node3; do sudo systemctl enable --now "ainative@$n"; done

# 5. web tier
sudo rsync -a website/ /var/www/ainative/
sudo sed "s/DOMAIN/chains.example.com/g" deploy/nginx-ainative.conf \
  | sudo tee /etc/nginx/sites-available/ainative
sudo ln -sf /etc/nginx/sites-available/ainative /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d chains.example.com      # TLS, auto-renews

# 6. firewall: only web is public; P2P stays on loopback
sudo ufw allow 80,443/tcp && sudo ufw enable
```

## Ongoing updates

Push to `main`, then on the VPS:

```bash
sudo -u ainative bash deploy/deploy.sh
```

## Verify from outside

```bash
curl https://chains.example.com/status          # chain API through nginx
curl https://chains.example.com/blocks | head   # latest blocks
open  https://chains.example.com/               # landing site
open  https://chains.example.com/dashboard      # live explorer
```

## Notes & knobs

- **Admin safety**: mutating endpoints (`POST /tx`) are open by default for the
  demo; add `--api-token=<secret>` in `AIN_EXTRA` and send
  `Authorization: Bearer <secret>` once real value flows.
- **Rate limits**: nginx `ainapi` zone allows bursts of 40 at 20 r/s/IP — tune
  in `deploy/nginx-ainative.conf`.
- **Memory**: each idle node ≈ 60–120 MB. Proving spikes with rapidsnark are
  short; on a 1 GB box prefer snarkjs (`AIN_PROVER=snarkjs` in the env file).
- **Persistence**: chain state lives in `/var/lib/ainative/<node>/chain.db`
  (SQLite/WAL). Back it up like any database; `deploy.sh` never touches it.
- **Scaling out**: second VPS runs its own node pointing `AIN_EXTRA` peers at
  this host's public p2p port — open 5001–5003 only if you want inbound peers.
