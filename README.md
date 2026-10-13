# Obsidian Directorate Terminal — Self-Hosted

An Elite Dangerous settlement-terminal themed squadron site with an auth system,
configurable roles, and saved documents/reports. Zero npm dependencies —
Node.js built-ins only (`http`, `fs`, `crypto`, `path`, `url`).

## What's inside

- `server.js` — the whole backend. JSON-file persistence in `./data/`,
  scrypt password hashing, server-side sessions with `HttpOnly; SameSite=Lax` cookies.
- `public/index.html` — the entire frontend (HTML + CSS + JS in one file):
  boot gate, Elite-style startup animation, access screen with guest entry,
  report archive, report editor, personnel ledger, clearance matrix (roles),
  Discord/Inara copy-paste export.
- `obsidian-directorate.service` — systemd unit for autostart.

## Deploy on a VPS (Ubuntu/Debian)

```bash
# 1. Install Node.js 18+ (nodesource example)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # must be v18+

# 2. Create a service user and install the app
sudo useradd -r -m -d /opt/obsidian-directorate -s /usr/sbin/nologin obsidian
sudo cp -r /path/to/obsidian-directorate/. /opt/obsidian-directorate/
sudo chown -R obsidian:obsidian /opt/obsidian-directorate

# 3. Install and start the systemd service
sudo cp /opt/obsidian-directorate/obsidian-directorate.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now obsidian-directorate
sudo systemctl status obsidian-directorate

# 4. Open the firewall
sudo ufw allow 8080/tcp

# 5. Grab the generated admin password from the service logs
sudo journalctl -u obsidian-directorate | grep -A3 "first run"
# (also written to /opt/obsidian-directorate/data/admin-credentials.txt, mode 0600)
```

Then open `http://YOUR_SERVER_IP:8080`, sign in as `director`,
**change the director password immediately**, and delete
`data/admin-credentials.txt`.

To change the port, edit the `Environment=PORT=8080` line in the service
file, then `sudo systemctl daemon-reload && sudo systemctl restart obsidian-directorate`.

## Optional: reverse proxy + HTTPS (nginx)

```nginx
server {
    listen 80;
    server_name terminal.example.com;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Then `sudo certbot --nginx -d terminal.example.com` for Let's Encrypt HTTPS.
If you proxy, consider also `sudo ufw delete allow 8080/tcp` so the app is
only reachable through nginx.

## Backup

All state is plain JSON — back up the data directory:

```bash
sudo tar -czf od-backup-$(date +%F).tar.gz -C /opt/obsidian-directorate data
```

Restore by stopping the service, extracting over `data/`, fixing ownership
(`chown -R obsidian:obsidian`), and starting it again.

## Notes

- First registered account path: on a fresh `data/` dir the server
  auto-creates `director` with a random password (printed to stdout and saved
  to `data/admin-credentials.txt` with mode `0600`). Later registrations get
  the **Operative** role by default.
- Guests ("Enter as Guest") can only read `UNCLASSIFIED` transmissions.
- No analytics, no external requests — the page is fully self-contained.
