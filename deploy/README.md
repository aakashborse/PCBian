# Deploying PCBian

PCBian runs as one container (web app, API and the real-time collaboration websocket) with its
data in a volume, plus an optional backup sidecar. Any Linux VPS with Docker works (2 vCPU and
2 GB RAM is plenty for a team).

## 1. Start it

```sh
git clone https://github.com/aakashborse/PCBian.git && cd PCBian
cat > .env <<'EOF'
ANTHROPIC_API_KEY=sk-ant-...        # enables the AI copilot (optional)
MOUSER_API_KEY=...                  # live prices and stock in the BOM (optional)
PCBIAN_PORT=8787
EOF
docker compose up -d --build
```

Open `http://<server>:8787`. `docker compose ps` shows the health check; `docker compose logs -f pcbian`
shows the server log.

## 2. HTTPS

Put a reverse proxy in front for TLS. It must pass websockets (`/yjs`). With
[Caddy](https://caddyserver.com), the whole config is:

```
pcb.example.com {
    reverse_proxy localhost:8787
}
```

(nginx: `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`
on the location that proxies to port 8787.)

PCBian has no accounts yet: anyone who can reach the URL can open and edit projects. Keep it on
a private network or VPN, or add authentication at the proxy (Caddy `basicauth`, an SSO proxy
such as oauth2-proxy, or Cloudflare Access).

## 3. Backups

The `backup` service snapshots the data volume when it starts and then on `BACKUP_SCHEDULE`
(cron syntax, default 03:17 UTC daily) into the `pcbian-backups` volume, keeping
`BACKUP_KEEP_DAYS` (default 14) days. The server writes every file atomically, so a snapshot
never contains a half-written project.

To also copy each snapshot off the machine, add S3-compatible storage to `.env`:

```sh
BACKUP_S3_BUCKET=my-bucket
BACKUP_S3_PREFIX=pcbian
BACKUP_S3_ACCESS_KEY_ID=...
BACKUP_S3_SECRET_ACCESS_KEY=...
BACKUP_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # omit for AWS S3
BACKUP_S3_REGION=auto                                            # or your AWS region
```

Run a backup now: `docker compose exec backup sh /backup.sh`. List them:
`docker compose exec backup ls -lh /backups`.

## 4. Restore

```sh
docker compose stop pcbian
docker run --rm -v pcbian_pcbian-data:/data -v pcbian_pcbian-backups:/backups:ro alpine sh -c \
  'rm -rf /data/* && tar -xzf /backups/pcbian-YYYYmmdd-HHMMSS.tar.gz -C /data && chown -R 1000:1000 /data'
docker compose start pcbian
```

The volume names are `<compose project>_pcbian-data` and `_pcbian-backups` (`docker volume ls`).
For a snapshot from S3, download it into the backups volume first (or mount its folder instead).

## 5. Upgrade

```sh
git pull && docker compose up -d --build
```

Projects are stored as Yjs documents, so an upgrade keeps them; take a backup first anyway.

## Checking a deployment

- `curl http://<server>:8787/api/health` → `{"ok":true,...}`.
- Collaboration under load (N simulated users editing one throwaway project, then every
  replica and the server's copy must match):
  `npx tsx tools/loadtest/collab.ts --url https://pcb.example.com --clients 30 --edits 30`.
  On a laptop this passes with 60 clients making 3,600 concurrent edits, with updates reaching
  other clients in under 10 ms (p95) and every replica converging within half a second.
- Fabrication outputs: see `tools/fabcheck/README.md`.

## Building behind a TLS-inspecting proxy

Pass the proxy's CA as a build secret and the proxy itself as a build argument:

```sh
docker build --network host --build-arg HTTPS_PROXY=$HTTPS_PROXY \
  --secret id=npm_ca,src=/path/to/proxy-ca.crt -t pcbian .
```
