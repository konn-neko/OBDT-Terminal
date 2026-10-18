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

## Clearance model (three tiers)

Classifications are exactly three levels: **declassified**, **restricted**,
**classified**.

| Tier | Who | Sees |
|---|---|---|
| Guest | not signed in | `declassified` only |
| Member | any signed-in operator | `declassified` + `restricted` |
| High Command | roles flagged High Command | everything, incl. `classified` |

Each role carries an access tier (`member` or `high_command`), editable in the
Clearance Matrix. The Director role is seeded as High Command. The last
High Command role cannot be deleted or demoted.

Reference links (`/archive/<REF>`) enforce the same tiers: a guest opening a
restricted reference sees **RESTRICTED — MEMBER SIGN-IN REQUIRED**; a viewer
without High Command clearance opening a classified reference sees the
**ACCESS DENIED** page; unknown references get the black, glitching
**SIGNAL LOST** page (corrupted frame, signal jittering randomly 1–69%).

Every page — the main terminal and every permalink — opens with a BIOS
POST screen that runs slower, then offers SELECT INTERFACE: GUI keeps the
standard look, TERMINAL replaces the app with a pure command-line terminal
in the site's cyan palette — no GUI, just a prompt (help, login, archive,
read, new, copy, purge, personnel, roles, requests, lockdown, clear; `gui`
returns to the GUI), and the saved reports list under the terminal view on
entry. Saved reports (permalink pages) render as a terminal transcript
when Terminal is selected. Pick with a click, G / T, or Enter for GUI; the choice is saved and
applies to the main site. 403/404 pages keep their own themes in GUI mode
and get a terminal view when Terminal is selected. Reduced-motion skips
the BIOS. Each POST line types out character by character (30ms/char)
behind a blinking block cursor, pauses a beat with the cursor blinking,
then stamps a [OK] / [FAIL] / [WARN] indicator, with a longer gap before
the next line. Standard POST on normal pages; pure corrupted BIOS on 404
(fully opaque, so the page glitch can't show through; degrades in rare
RGB-artifact bursts); on 403 it starts standard, then midway cycles to red and flags the
terminal as HIGH COMMAND with clearance restricted.

SOS reports are always filed as **declassified** (forced at save time) and
render in crimson red.

## Account requests

There is no open self-registration. New operators request an account from the
sign-in screen (**No clearance? Request an account**): callsign, optional CMDR
name, a passphrase (min 8 chars), and an optional note for High Command.

High Command reviews the queue in the **Requests** tab (visible only to
High Command tier): each pending request shows callsign, CMDR, note, and filing
date, with **Approve** and **Deny** buttons. Approving commissions the account
with the default Operative (Member tier) role; the new operator then signs in
with the passphrase they chose. Denying discards the request.

The first-run `director` bootstrap is unaffected — the initial admin account is
still created automatically with a random password on a fresh `data/` dir.

## Reports & REF codes

Every saved report gets an immutable reference code generated once at filing:

```
OBDT-YYYYMMDD-HHMMSS-NNNN   e.g. OBDT-20261013-143022-0042
```

`YYYYMMDD-HHMMSS` is the filing date/time; `NNNN` is the zero-padded archive
sequence (first report ever filed = `0001`). Revisions never regenerate the REF.

Required fields: **Report Title**, **Reporting CMDR**. Optional: **Signing CMDR**,
**Sector**, **Directed To**. Intelligence Reports and Major Orders require a
subtype; Diplomatic Communiques require a Recipient Party. Each report has a
permalink at `/archive/<REF>`.

| Report Type | Subtype / extra field |
|---|---|
| SOS | (none — always DECLASSIFIED) |
| Intelligence Report | Espionage Attempt, CMDR Sighting, BGS/PowerPlay, Market Changes |
| Diplomatic Communique | Recipient Party (required, instead of a subtype) |
| Major Order | Power Play Undermining, Power Play Reinforce, Power Play Acquisition |

## Export formats

- **Copy for Discord** — plain-text classified-transmission template: role ping
  `<@&1507659469516046489>`, transmission header (URGENT for SOS), inline-code
  `REF:` / `CLASSIFICATION:` stamps, bold labeled fields (including a `Subtype:`
  line when the report has one, and a `Recipient Party:` line for Diplomatic
  Communiques), fenced body block, signed footer. Classification labels:
  `DECLASSIFIED`, `DIRECTORATE PERSONNEL`, `OBSIDIAN EYES ONLY`.
- **Copy for Inara** — embedded rich HTML on the clipboard (renders formatted on
  paste, no visible markers), with a plain-text fallback. Both the HTML and the
  plain-text fallback carry the same fields as the Discord copy, including
  `Subtype:` and `Recipient Party:` lines when applicable.

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

- First-run: on a fresh `data/` dir the server auto-creates `director`
  (High Command) with a random password (printed to stdout and saved to
  `data/admin-credentials.txt` with mode `0600`). Later registrations get the
  **Operative** (Member tier) role by default.
- Guests ("Enter as Guest") can only read `declassified` transmissions.
- No analytics, no external requests — the page is fully self-contained.
