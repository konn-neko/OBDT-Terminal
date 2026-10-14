#!/usr/bin/env node
/*
 * Obsidian Directorate Terminal — self-hosted squadron terminal.
 *
 * Zero npm dependencies. Node.js 18+ built-ins only (http, fs, crypto, path, url).
 * Run with:  node server.js          (listens on PORT env var, default 8080)
 *
 * Data lives in ./data/*.json (auto-created on first run).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// Config & constants
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '8080', 10) || 8080;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const BODY_LIMIT = 1 << 20; // 1 MiB max JSON body

// Classification model: exactly three levels.
const CLASSIFICATIONS = ['declassified', 'restricted', 'classified'];
// Access tiers: guest (not logged in) < member (any logged-in role) < high_command.
const TIERS = ['member', 'high_command'];
const REPORT_TYPES = ['SOS', 'Intelligence Report', 'Diplomatic Communique'];
const SUBTYPES = {
  'Intelligence Report': ['Espionage Attempt', 'CMDR Sighting', 'BGS/PowerPlay', 'Market Changes'],
};
const PERMISSIONS = [
  'create_report',
  'edit_report',
  'delete_report',
  'manage_users',
  'manage_roles',
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Tiny JSON-file database (atomic writes via tmp + rename)
// ---------------------------------------------------------------------------
function loadJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(name, data) {
  const tmp = path.join(DATA_DIR, `${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, path.join(DATA_DIR, name));
}

const db = {
  users: loadJson('users.json', []),
  roles: loadJson('roles.json', []),
  reports: loadJson('reports.json', []),
  sessions: loadJson('sessions.json', {}),
  meta: loadJson('meta.json', { reportSeq: 0, lockdown: false }),
  requests: loadJson('requests.json', []),
};

function saveAll() {
  saveJson('users.json', db.users);
  saveJson('roles.json', db.roles);
  saveJson('reports.json', db.reports);
  saveJson('sessions.json', db.sessions);
  saveJson('meta.json', db.meta);
  saveJson('requests.json', db.requests);
}

function rid() {
  return crypto.randomBytes(12).toString('hex');
}

// ---------------------------------------------------------------------------
// First-run seeding: roles + admin user with a RANDOM password
// ---------------------------------------------------------------------------
function seedIfEmpty() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Ensure the lockdown flag exists on databases created before it.
  if (typeof db.meta.lockdown !== 'boolean') {
    db.meta.lockdown = false;
    saveJson('meta.json', db.meta);
  }

  if (db.roles.length === 0) {
    const all = Object.fromEntries(PERMISSIONS.map((p) => [p, true]));
    const none = Object.fromEntries(PERMISSIONS.map((p) => [p, false]));
    db.roles.push(
      { id: rid(), name: 'Director', tier: 'high_command', permissions: { ...all } },
      {
        id: rid(),
        name: 'Officer',
        tier: 'member',
        permissions: { ...all, manage_users: false, manage_roles: false },
      },
      {
        id: rid(),
        name: 'Operative',
        tier: 'member',
        permissions: { ...none, create_report: true, edit_report: true },
      }
    );
  } else {
    // Repair pass for databases seeded by older builds: ensure tier exists
    // and backfill any missing permission keys so tab gating keeps working.
    let dirty = false;
    for (const r of db.roles) {
      if (r.tier !== 'member' && r.tier !== 'high_command') {
        r.tier = r.name === 'Director' ? 'high_command' : 'member';
        dirty = true;
      }
      if (!r.permissions || typeof r.permissions !== 'object') {
        r.permissions = {};
        dirty = true;
      }
      if ('view_classified' in r.permissions) {
        delete r.permissions.view_classified;
        dirty = true;
      }
      const isHC = r.tier === 'high_command';
      for (const p of PERMISSIONS) {
        if (!(p in r.permissions)) {
          r.permissions[p] = isHC ? true : p === 'create_report';
          dirty = true;
        }
      }
      // The Director role always carries every permission.
      if (r.name === 'Director') {
        for (const p of PERMISSIONS) {
          if (r.permissions[p] !== true) {
            r.permissions[p] = true;
            dirty = true;
          }
        }
      }
    }
    // Guarantee at least one high_command role exists.
    if (!db.roles.some((r) => r.tier === 'high_command')) {
      const director = db.roles.find((r) => r.name === 'Director') || db.roles[0];
      if (director) {
        director.tier = 'high_command';
        dirty = true;
      }
    }
    if (dirty) saveJson('roles.json', db.roles);
  }

  if (db.users.length === 0) {
    let directorRole = db.roles.find((r) => r.tier === 'high_command');
    if (!directorRole) {
      directorRole = {
        id: rid(),
        name: 'Director',
        tier: 'high_command',
        permissions: Object.fromEntries(PERMISSIONS.map((p) => [p, true])),
      };
      db.roles.push(directorRole);
    }
    const password = crypto.randomBytes(12).toString('base64url'); // 16 chars
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    db.users.push({
      id: rid(),
      username: 'director',
      cmdr: '',
      salt,
      hash,
      roleId: directorRole.id,
      createdAt: new Date().toISOString(),
    });
    saveAll();

    const credPath = path.join(DATA_DIR, 'admin-credentials.txt');
    fs.writeFileSync(
      credPath,
      'Obsidian Directorate Terminal — initial admin credentials\n\n' +
        'Username: director\n' +
        `Password: ${password}\n\n` +
        'CHANGE THIS PASSWORD IMMEDIATELY AFTER FIRST LOGIN.\n' +
        'Then delete this file.\n',
      { mode: 0o600 }
    );

    console.log('================================================================');
    console.log('  OBSIDIAN DIRECTORATE TERMINAL — first run');
    console.log('  Admin user created: director');
    console.log(`  Admin password:     ${password}`);
    console.log('  (also written to data/admin-credentials.txt, mode 0600)');
    console.log('  CHANGE THIS PASSWORD IMMEDIATELY AFTER FIRST LOGIN.');
    console.log('================================================================');
  } else {
    // Make sure data dir exists even when not seeding.
    saveAll();
  }
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// Returns { token, user } or null. Prunes expired/dead sessions.
function getSession(req) {
  const token = parseCookies(req).od_session;
  if (!token || typeof token !== 'string' || token.length > 128) return null;
  const s = db.sessions[token];
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    delete db.sessions[token];
    saveJson('sessions.json', db.sessions);
    return null;
  }
  const user = db.users.find((u) => u.id === s.userId);
  if (!user) {
    delete db.sessions[token];
    saveJson('sessions.json', db.sessions);
    return null;
  }
  return { token, user };
}

function roleOf(user) {
  return db.roles.find((r) => r.id === user.roleId) || null;
}

function tierOf(user) {
  const role = user && roleOf(user);
  return role && role.tier === 'high_command' ? 'high_command' : 'member';
}

function isHighCommand(user) {
  return !!user && tierOf(user) === 'high_command';
}

// Classifications a viewer is allowed to read.
function visibleClassifications(user) {
  if (!user) return ['declassified'];
  if (isHighCommand(user)) return [...CLASSIFICATIONS];
  return ['declassified', 'restricted'];
}

function canSeeReport(user, report) {
  return report && visibleClassifications(user).includes(report.classification);
}

function can(user, perm) {
  const role = roleOf(user);
  return !!(role && role.permissions && role.permissions[perm]);
}

function publicUser(user) {
  const role = roleOf(user);
  return {
    id: user.id,
    username: user.username,
    cmdr: user.cmdr || '',
    roleId: user.roleId,
    roleName: role ? role.name : 'Unknown',
    tier: role && role.tier === 'high_command' ? 'high_command' : 'member',
    permissions: role && role.permissions ? { ...role.permissions } : {},
    createdAt: user.createdAt,
  };
}

function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `od_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'od_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { userId, createdAt: Date.now() };
  saveJson('sessions.json', db.sessions);
  return token;
}

function verifyPassword(password, salt, hash) {
  try {
    const derived = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// REF codes: OBDT-YYYYMMDD-HHMMSS-NNNN (generated once at creation, immutable)
// ---------------------------------------------------------------------------
function pad2(n) {
  return String(n).padStart(2, '0');
}

function nextRef() {
  const now = new Date();
  const stamp =
    `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-` +
    `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  db.meta.reportSeq = (db.meta.reportSeq || 0) + 1;
  saveJson('meta.json', db.meta);
  return `OBDT-${stamp}-${String(db.meta.reportSeq).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function sendHtml(res, status, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(Object.assign(new Error('JSON body must be an object'), { status: 400 }));
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Validation helpers — never trust client data
// ---------------------------------------------------------------------------
const isStr = (v) => typeof v === 'string';

function validUsername(u) {
  return isStr(u) && /^[A-Za-z0-9_-]{3,24}$/.test(u);
}

function validPassword(p) {
  return isStr(p) && p.length >= 8 && p.length <= 128;
}

function optStr(v, max) {
  if (v == null || v === '') return '';
  if (!isStr(v)) return null;
  const t = v.trim();
  return t.length <= max ? t : null;
}

// Validate a report payload. Returns { ok, value } or { ok:false, error }.
// SOS is ALWAYS forced to declassified, no matter what is submitted.
function validateReportPayload(body) {
  const reportingCmdr = isStr(body.reportingCmdr) ? body.reportingCmdr.trim() : '';
  const signingCmdr = optStr(body.signingCmdr, 64);
  const title = isStr(body.title) ? body.title.trim() : '';
  const type = body.type;
  const bodyText = isStr(body.body) ? body.body : '';
  const sector = optStr(body.sector, 200);
  const directedTo = optStr(body.directedTo, 200);

  if (!reportingCmdr || reportingCmdr.length > 64)
    return { ok: false, error: 'Reporting CMDR is required (max 64 chars).' };
  if (signingCmdr === null) return { ok: false, error: 'Signing CMDR is too long (max 64 chars).' };
  if (!title || title.length > 200) return { ok: false, error: 'Report title is required (max 200 chars).' };
  if (!REPORT_TYPES.includes(type)) return { ok: false, error: 'Invalid report type.' };
  if (!bodyText.trim() || bodyText.length > 20000)
    return { ok: false, error: 'Report body is required (max 20000 chars).' };
  if (sector === null) return { ok: false, error: 'Sector is too long (max 200 chars).' };
  if (directedTo === null) return { ok: false, error: 'Directed To is too long (max 200 chars).' };

  let classification = body.classification;
  if (type === 'SOS') {
    // SOS transmissions are always declassified, regardless of what was submitted.
    classification = 'declassified';
  } else if (!CLASSIFICATIONS.includes(classification)) {
    return { ok: false, error: 'Invalid classification.' };
  }

  let subtype = '';
  let recipient = '';

  if (type === 'Intelligence Report') {
    if (!isStr(body.subtype) || !SUBTYPES[type].includes(body.subtype))
      return { ok: false, error: 'A valid intelligence subtype is required.' };
    subtype = body.subtype;
  } else if (isStr(body.subtype) && body.subtype !== '') {
    return { ok: false, error: 'Subtype is only valid for Intelligence Reports.' };
  }

  if (type === 'Diplomatic Communique') {
    recipient = isStr(body.recipient) ? body.recipient.trim() : '';
    if (!recipient || recipient.length > 200)
      return { ok: false, error: 'Recipient party is required (max 200 chars).' };
  } else if (isStr(body.recipient) && body.recipient.trim() !== '') {
    return { ok: false, error: 'Recipient party is only valid for Diplomatic Communiques.' };
  }

  return {
    ok: true,
    value: { reportingCmdr, signingCmdr, title, classification, type, subtype, recipient, sector, directedTo, body: bodyText },
  };
}

function visibleReports(user) {
  const allowed = visibleClassifications(user);
  return db.reports
    .filter((r) => allowed.includes(r.classification))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function applyReportFilters(list, query) {
  let out = list;
  if (query.type && REPORT_TYPES.includes(query.type)) out = out.filter((r) => r.type === query.type);
  if (query.classification && CLASSIFICATIONS.includes(query.classification))
    out = out.filter((r) => r.classification === query.classification);
  if (query.q && query.q.trim()) {
    const q = query.q.trim().toLowerCase();
    out = out.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.body.toLowerCase().includes(q) ||
        (r.reportingCmdr || '').toLowerCase().includes(q) ||
        (r.ref || '').toLowerCase().includes(q)
    );
  }
  return out;
}

function publicReport(r) {
  return {
    id: r.id,
    ref: r.ref || null,
    reportingCmdr: r.reportingCmdr || r.cmdr || '',
    signingCmdr: r.signingCmdr || '',
    title: r.title,
    classification: r.classification,
    type: r.type,
    subtype: r.subtype || '',
    recipient: r.recipient || '',
    sector: r.sector || '',
    directedTo: r.directedTo || '',
    body: r.body,
    authorUsername: r.authorUsername,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Permalink page (/archive/<REF>) — server-rendered focused reference view
// ---------------------------------------------------------------------------
const escHtml = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const PERMA_CSS = `
:root{--bg0:#03080f;--line:#123a5e;--line-bright:#1e5a8f;--cyan:#46c8ff;--cyan-bright:#aee7ff;
--text:#c9e8ff;--muted:#5f87a8;--faint:#33506b;--green:#4fe08a;--amber:#ffb454;--red:#ff5470;
--mono:"Cascadia Code","JetBrains Mono",ui-monospace,Menlo,Consolas,monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{background:#03080f;color:#c9e8ff;font-family:var(--mono);font-size:14px;line-height:1.6;min-height:100vh;
display:flex;align-items:center;justify-content:center;padding:32px 16px;
background-image:radial-gradient(ellipse at 50% -10%,#0a2038 0%,#03080f 60%)}
#fx-scanlines{position:fixed;inset:0;pointer-events:none;z-index:50;opacity:.5;
background:repeating-linear-gradient(0deg,rgba(0,0,0,.22) 0 1px,transparent 1px 3px)}
.card{border:1px solid var(--line-bright);background:rgba(6,18,31,.92);max-width:760px;width:100%;
box-shadow:0 0 40px rgba(70,200,255,.10);position:relative;z-index:1}
.banner{padding:14px 20px;letter-spacing:4px;font-size:13px;text-align:center;border-bottom:1px solid var(--line-bright)}
.banner.sos{background:rgba(255,84,112,.10);color:var(--red);border-bottom:1px solid #7a2c3d}
.banner.cls{background:rgba(70,200,255,.06);color:var(--cyan-bright)}
.body{padding:28px}
h1{font-size:20px;color:var(--cyan-bright);letter-spacing:2px;margin:8px 0 4px;font-weight:normal}
h1.sos{color:var(--red)}
.refline{color:var(--muted);font-size:12px;letter-spacing:2px;margin-bottom:18px}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:20px}
.meta div{border:1px solid var(--line);padding:8px 12px;background:rgba(4,12,22,.6)}
.k{font-size:10px;letter-spacing:3px;color:var(--muted)}
.v{font-size:13px}
.text{white-space:pre-wrap;border:1px solid var(--line);padding:18px;background:#030a14;margin-bottom:20px}
.sign{color:var(--muted);font-size:13px;margin-bottom:24px}
a.ret{display:inline-block;color:var(--cyan);border:1px solid #1e5a8f;padding:10px 22px;text-decoration:none;
letter-spacing:2px;font-size:13px}
a.ret:hover{background:rgba(70,200,255,.12);border-color:var(--cyan)}
.denied{text-align:center;padding:20px}
.denied .code{font-size:16px;letter-spacing:3px;color:var(--amber);margin:16px 0}
.stamp{border:3px double var(--cyan);padding:10px 26px;color:var(--cyan-bright);letter-spacing:6px;font-size:15px;
display:inline-block;margin-bottom:20px;transform:rotate(-2deg)}
/* SOS transmissions: full crimson theme */
body.sos-theme{--cyan:#ff5470;--cyan-bright:#ffc2cd;--text:#ffd9e0;--muted:#c07a88;--faint:#8a4a56;
--line:#7a2c3d;--line-bright:#a33a4d;--red:#ff5470;
background-image:radial-gradient(ellipse at 50% -10%,#3a0a14 0%,#0f0307 60%)}
body.sos-theme .card{box-shadow:0 0 44px rgba(255,84,112,.20);background:rgba(24,7,11,.94)}
body.sos-theme .meta div{background:rgba(20,5,9,.6)}
body.sos-theme .text{background:#12040a}`;

function permaPage({ bannerClass, bannerText, titleHtml, refLine, metaRows, bodyHtml, signHtml, backHref, ogTitle, ogDescription, themeColor, bodyClass }) {
  const meta = metaRows
    .map(([k, v]) => `<div><div class="k">${escHtml(k)}</div><div class="v">${escHtml(v)}</div></div>`)
    .join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta property="og:type" content="website">
<meta property="og:site_name" content="The Obsidian Directorate">
<meta property="og:title" content="${escHtml(ogTitle)}">
<meta property="og:description" content="${escHtml(ogDescription)}">
<meta name="theme-color" content="${escHtml(themeColor || '#46c8ff')}">
<title>${escHtml(ogTitle)} — Obsidian Directorate</title><style>${PERMA_CSS}</style></head><body class="${escHtml(bodyClass || '')}">
<div id="fx-scanlines"></div><div class="card">
<div class="banner ${bannerClass}">${escHtml(bannerText)}</div>
<div class="body">${titleHtml}${refLine}<div class="meta">${meta}</div>
<div class="text">${bodyHtml}</div>${signHtml}
<div style="margin-top:8px"><a class="ret" href="${backHref}">&larr; RETURN TO ARCHIVE</a></div>
</div></div></body></html>`;
}

function permaDeniedPage(message) {
  const isRestricted = message.includes('RESTRICTED');
  const isClassified = message.includes('CLASSIFIED');
  const ogTitle = isRestricted
    ? 'Restricted Transmission — The Obsidian Directorate'
    : isClassified
      ? 'Classified Transmission — The Obsidian Directorate'
      : 'Transmission Not Found — The Obsidian Directorate';
  const ogDescription = (isRestricted || isClassified)
    ? `${message} — Sign in to the terminal to view this transmission.`
    : 'This transmission reference does not exist.';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta property="og:type" content="website">
<meta property="og:site_name" content="The Obsidian Directorate">
<meta property="og:title" content="${escHtml(ogTitle)}">
<meta property="og:description" content="${escHtml(ogDescription)}">
<meta name="theme-color" content="#ffb454">
<title>${escHtml(ogTitle)}</title><style>${PERMA_CSS}</style></head><body>
<div id="fx-scanlines"></div><div class="card"><div class="denied">
<div class="stamp">THE OBSIDIAN DIRECTORATE</div>
<div class="code">${escHtml(message)}</div>
<div style="color:var(--muted);font-size:13px;margin-bottom:24px">This transmission reference is beyond your current clearance.</div>
<div><a class="ret" href="/">&larr; RETURN TO TERMINAL</a></div>
</div></div></body></html>`;
}

// Resolve a permalink request: { status, report?, denial? }
function resolveRef(ref, user) {
  const report = db.reports.find((r) => r.ref === ref);
  if (!report) return { status: 404, denial: 'REFERENCE NOT FOUND' };
  if (!canSeeReport(user, report)) {
    if (report.classification === 'restricted')
      return { status: 403, denial: 'RESTRICTED — MEMBER SIGN-IN REQUIRED' };
    return { status: 403, denial: 'CLASSIFIED — HIGH COMMAND REQUIRED' };
  }
  return { status: 200, report };
}

function servePermalink(req, res, ref) {
  const session = getSession(req);
  const user = session ? session.user : null;
  const result = resolveRef(ref, user);
  if (result.status !== 200) {
    return sendHtml(res, result.status, permaDeniedPage(result.denial));
  }
  const r = publicReport(result.report);
  const isSos = r.type === 'SOS';
  const bannerText = isSos
    ? 'THE OBSIDIAN DIRECTORATE — URGENT TRANSMISSION'
    : 'THE OBSIDIAN DIRECTORATE — CLASSIFIED TRANSMISSION';
  const metaRows = [
    ['TITLE', r.title],
    ['REPORT TYPE', r.subtype ? `${r.type} / ${r.subtype}` : r.type],
    ['FILED BY', r.reportingCmdr],
  ];
  if (r.sector) metaRows.push(['SECTOR', r.sector]);
  if (r.directedTo) metaRows.push(['DIRECTED TO', r.directedTo]);
  if (r.recipient) metaRows.push(['RECIPIENT PARTY', r.recipient]);
  metaRows.push(['CLASSIFICATION', r.classification.toUpperCase()]);
  metaRows.push(['FILED', new Date(r.createdAt).toLocaleString()]);
  const signHtml = r.signingCmdr
    ? `<div class="sign"><b>Signed,</b><br>CMDR ${escHtml(r.signingCmdr)}<br><i>The Obsidian Directorate</i></div>`
    : '';
  // Discord embed gist (declassified only — crawlers are unauthenticated guests).
  const d = new Date(r.createdAt);
  const dateStr = `${String(d.getDate()).padStart(2, '0')} ${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()]} ${d.getFullYear()}`;
  const typeStr = r.subtype ? `${r.type} / ${r.subtype}` : r.type;
  const bodySnippet = r.body.length > 200 ? r.body.slice(0, 200).trimEnd() + '…' : r.body;
  const ogTitle = `${r.title} — ${typeStr}`;
  const ogDescription = `${typeStr} · Filed by ${r.reportingCmdr} · ${dateStr} · REF ${r.ref}\n${bodySnippet}`;
  return sendHtml(
    res,
    200,
    permaPage({
      bannerClass: isSos ? 'sos' : 'cls',
      bannerText,
      titleHtml: `<h1 class="${isSos ? 'sos' : ''}">${escHtml(r.title)}</h1>`,
      refLine: `<div class="refline">REF: ${escHtml(r.ref)} &nbsp;|&nbsp; CLASSIFICATION: ${escHtml(r.classification.toUpperCase())}</div>`,
      metaRows,
      bodyHtml: escHtml(r.body),
      signHtml,
      backHref: '/',
      ogTitle,
      ogDescription,
      themeColor: isSos ? '#ff5470' : '#46c8ff',
      bodyClass: isSos ? 'sos-theme' : '',
    })
  );
}

// ---------------------------------------------------------------------------
// API route handlers
// ---------------------------------------------------------------------------
async function handleApi(req, res, pathname, query) {
  const session = getSession(req);
  const user = session ? session.user : null;
  const needAuth = () => {
    if (!user) {
      sendError(res, 401, 'Authentication required.');
      return false;
    }
    return true;
  };
  const needPerm = (perm) => {
    if (!needAuth()) return false;
    if (!can(user, perm)) {
      sendError(res, 403, 'Insufficient clearance.');
      return false;
    }
    return true;
  };
  const needHighCommand = () => {
    if (!needAuth()) return false;
    if (!isHighCommand(user)) {
      sendError(res, 403, 'High Command clearance required.');
      return false;
    }
    return true;
  };

  // -- Account requests --------------------------------------------------
  // PUBLIC: anyone may request an account. High Command reviews the queue.
  if (req.method === 'POST' && pathname === '/api/requests') {
    const body = await readJsonBody(req);
    const username = isStr(body.username) ? body.username.trim() : '';
    const password = body.password;
    const cmdr = isStr(body.cmdr) ? body.cmdr.trim().slice(0, 64) : '';
    const note = isStr(body.note) ? body.note.trim().slice(0, 500) : '';
    if (!validUsername(username))
      return sendError(res, 400, 'Username must be 3–24 chars: letters, numbers, _ or -.');
    if (!validPassword(password))
      return sendError(res, 400, 'Password must be 8–128 characters.');
    const taken =
      db.users.some((u) => u.username.toLowerCase() === username.toLowerCase()) ||
      db.requests.some((r) => r.username.toLowerCase() === username.toLowerCase());
    if (taken) return sendError(res, 409, 'Callsign is already taken or under review.');

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
    db.requests.push({
      id: rid(),
      username,
      cmdr,
      passwordHash,
      salt,
      note,
      createdAt: new Date().toISOString(),
    });
    saveJson('requests.json', db.requests);
    return sendJson(res, 201, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/requests') {
    if (!needHighCommand()) return;
    const list = db.requests
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => ({
        id: r.id,
        username: r.username,
        cmdr: r.cmdr || '',
        note: r.note || '',
        createdAt: r.createdAt,
      }));
    return sendJson(res, 200, { requests: list });
  }

  const approveMatch = pathname.match(/^\/api\/requests\/([0-9a-f]+)\/approve$/);
  if (req.method === 'POST' && approveMatch) {
    if (!needHighCommand()) return;
    const idx = db.requests.findIndex((r) => r.id === approveMatch[1]);
    if (idx === -1) return sendError(res, 404, 'Request not found.');
    const rq = db.requests[idx];
    if (db.users.some((u) => u.username.toLowerCase() === rq.username.toLowerCase())) {
      db.requests.splice(idx, 1);
      saveJson('requests.json', db.requests);
      return sendError(res, 409, 'Callsign is already taken.');
    }
    const role =
      db.roles.find((r) => r.name === 'Operative') ||
      db.roles.find((r) => r.tier === 'member') ||
      db.roles[0];
    if (!role) return sendError(res, 500, 'No roles configured.');
    db.users.push({
      id: rid(),
      username: rq.username,
      cmdr: rq.cmdr || '',
      salt: rq.salt,
      hash: rq.passwordHash,
      roleId: role.id,
      createdAt: new Date().toISOString(),
    });
    db.requests.splice(idx, 1);
    saveJson('users.json', db.users);
    saveJson('requests.json', db.requests);
    return sendJson(res, 200, { ok: true, username: rq.username });
  }

  const denyMatch = pathname.match(/^\/api\/requests\/([0-9a-f]+)\/deny$/);
  if (req.method === 'POST' && denyMatch) {
    if (!needHighCommand()) return;
    const idx = db.requests.findIndex((r) => r.id === denyMatch[1]);
    if (idx === -1) return sendError(res, 404, 'Request not found.');
    db.requests.splice(idx, 1);
    saveJson('requests.json', db.requests);
    return sendJson(res, 200, { ok: true });
  }

  // -- Squadron lockdown ----------------------------------------------------
  // GET is public (boot sequence and guests need it); POST is High Command only.
  if (req.method === 'GET' && pathname === '/api/lockdown') {
    return sendJson(res, 200, { lockdown: !!db.meta.lockdown });
  }
  if (req.method === 'POST' && pathname === '/api/lockdown') {
    if (!needHighCommand()) return;
    const body = await readJsonBody(req);
    db.meta.lockdown = !!body.enabled;
    saveJson('meta.json', db.meta);
    return sendJson(res, 200, { lockdown: db.meta.lockdown });
  }
  // -- Auth ---------------------------------------------------------------
  if (req.method === 'POST' && pathname === '/api/login') {
    const body = await readJsonBody(req);
    const username = isStr(body.username) ? body.username.trim() : '';
    const password = body.password;
    const found = db.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!found || !isStr(password) || !verifyPassword(password, found.salt, found.hash)) {
      return sendError(res, 401, 'Invalid credentials.');
    }
    const token = createSession(found.id);
    saveAll();
    setSessionCookie(res, token);
    return sendJson(res, 200, { user: publicUser(found) });
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    if (session) {
      delete db.sessions[session.token];
      saveJson('sessions.json', db.sessions);
    }
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/me') {
    if (!needAuth()) return;
    return sendJson(res, 200, { user: publicUser(user) });
  }

  // -- Reports -------------------------------------------------------------
  if (req.method === 'GET' && pathname === '/api/declassified') {
    // PUBLIC: declassified reports only, no auth required.
    const list = db.reports
      .filter((r) => r.classification === 'declassified')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return sendJson(res, 200, { reports: applyReportFilters(list, query).map(publicReport) });
  }

  const refApiMatch = pathname.match(/^\/api\/reports\/ref\/(.+)$/);
  if (refApiMatch && req.method === 'GET') {
    const result = resolveRef(decodeURIComponent(refApiMatch[1]), user);
    if (result.status !== 200) {
      return sendError(res, result.status, result.denial);
    }
    return sendJson(res, 200, { report: publicReport(result.report) });
  }

  if (req.method === 'GET' && pathname === '/api/reports') {
    const list = applyReportFilters(visibleReports(user), query);
    return sendJson(res, 200, { reports: list.map(publicReport) });
  }

  if (req.method === 'POST' && pathname === '/api/reports') {
    if (!needPerm('create_report')) return;
    if (db.meta.lockdown && !isHighCommand(user)) {
      return sendError(res, 403, 'SQUADRON LOCKDOWN — only High Command may file reports.');
    }
    const body = await readJsonBody(req);
    const v = validateReportPayload(body);
    if (!v.ok) return sendError(res, 400, v.error);
    const now = new Date().toISOString();
    const report = {
      id: rid(),
      ref: nextRef(),
      ...v.value,
      authorId: user.id,
      authorUsername: user.username,
      createdAt: now,
      updatedAt: now,
    };
    db.reports.push(report);
    saveJson('reports.json', db.reports);
    return sendJson(res, 201, { report: publicReport(report) });
  }

  const reportIdMatch = pathname.match(/^\/api\/reports\/([0-9a-f]{24})$/);
  if (reportIdMatch) {
    const report = db.reports.find((r) => r.id === reportIdMatch[1]);
    if (!canSeeReport(user, report)) return sendError(res, 404, 'Report not found.');

    if (req.method === 'GET') {
      return sendJson(res, 200, { report: publicReport(report) });
    }

    if (req.method === 'PUT') {
      if (!needAuth()) return;
      const allowed = can(user, 'edit_report') || report.authorId === user.id;
      if (!allowed) return sendError(res, 403, 'Insufficient clearance.');
      const body = await readJsonBody(req);
      const v = validateReportPayload(body);
      if (!v.ok) return sendError(res, 400, v.error);
      // REF and createdAt are immutable — revisions preserve the original filing.
      Object.assign(report, v.value, { updatedAt: new Date().toISOString() });
      saveJson('reports.json', db.reports);
      return sendJson(res, 200, { report: publicReport(report) });
    }

    if (req.method === 'DELETE') {
      if (!needAuth()) return;
      const allowed = can(user, 'delete_report') || report.authorId === user.id;
      if (!allowed) return sendError(res, 403, 'Insufficient clearance.');
      db.reports = db.reports.filter((r) => r.id !== report.id);
      saveJson('reports.json', db.reports);
      return sendJson(res, 200, { ok: true });
    }
  }

  // -- Roles (manage_roles) -------------------------------------------------
  if (pathname === '/api/roles') {
    if (!needPerm('manage_roles')) return;
    if (req.method === 'GET') return sendJson(res, 200, { roles: db.roles });
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const name = isStr(body.name) ? body.name.trim() : '';
      if (!name || name.length > 40) return sendError(res, 400, 'Role name is required (max 40 chars).');
      if (db.roles.some((r) => r.name.toLowerCase() === name.toLowerCase()))
        return sendError(res, 409, 'A role with that name already exists.');
      const tier = body.tier === 'high_command' ? 'high_command' : 'member';
      const permissions = {};
      for (const p of PERMISSIONS) permissions[p] = !!(body.permissions && body.permissions[p]);
      const role = { id: rid(), name, tier, permissions };
      db.roles.push(role);
      saveJson('roles.json', db.roles);
      return sendJson(res, 201, { role });
    }
  }

  const roleIdMatch = pathname.match(/^\/api\/roles\/([0-9a-f]{24})$/);
  if (roleIdMatch) {
    if (!needPerm('manage_roles')) return;
    const role = db.roles.find((r) => r.id === roleIdMatch[1]);
    if (!role) return sendError(res, 404, 'Role not found.');
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      const name = isStr(body.name) ? body.name.trim() : '';
      if (!name || name.length > 40) return sendError(res, 400, 'Role name is required (max 40 chars).');
      if (db.roles.some((r) => r.id !== role.id && r.name.toLowerCase() === name.toLowerCase()))
        return sendError(res, 409, 'A role with that name already exists.');
      role.name = name;
      if (body.tier === 'member' || body.tier === 'high_command') {
        if (role.tier === 'high_command' && body.tier === 'member') {
          const otherHc = db.roles.some((r) => r.id !== role.id && r.tier === 'high_command');
          if (!otherHc) return sendError(res, 400, 'Cannot demote the last High Command role.');
        }
        role.tier = body.tier;
      }
      if (body.permissions && typeof body.permissions === 'object') {
        for (const p of PERMISSIONS) role.permissions[p] = !!body.permissions[p];
      }
      saveJson('roles.json', db.roles);
      return sendJson(res, 200, { role });
    }
    if (req.method === 'DELETE') {
      if (db.users.some((u) => u.roleId === role.id))
        return sendError(res, 400, 'Role is assigned to users. Reassign them first.');
      if (role.tier === 'high_command') {
        const otherHc = db.roles.some((r) => r.id !== role.id && r.tier === 'high_command');
        if (!otherHc) return sendError(res, 400, 'Cannot delete the last High Command role.');
      }
      db.roles = db.roles.filter((r) => r.id !== role.id);
      saveJson('roles.json', db.roles);
      return sendJson(res, 200, { ok: true });
    }
  }

  // -- Users (manage_users) -------------------------------------------------
  if (req.method === 'GET' && pathname === '/api/users') {
    if (!needPerm('manage_users')) return;
    return sendJson(res, 200, { users: db.users.map(publicUser) });
  }

  const userRoleMatch = pathname.match(/^\/api\/users\/([0-9a-f]{24})\/role$/);
  if (userRoleMatch && req.method === 'PUT') {
    if (!needPerm('manage_users')) return;
    const target = db.users.find((u) => u.id === userRoleMatch[1]);
    if (!target) return sendError(res, 404, 'User not found.');
    if (target.id === user.id) return sendError(res, 400, 'You cannot change your own role.');
    const body = await readJsonBody(req);
    const role = db.roles.find((r) => r.id === body.roleId);
    if (!role) return sendError(res, 400, 'Invalid role.');
    target.roleId = role.id;
    saveJson('users.json', db.users);
    return sendJson(res, 200, { user: publicUser(target) });
  }

  const userResetMatch = pathname.match(/^\/api\/users\/([0-9a-f]{24})\/reset-password$/);
  if (userResetMatch && req.method === 'POST') {
    if (!needPerm('manage_users')) return;
    const target = db.users.find((u) => u.id === userResetMatch[1]);
    if (!target) return sendError(res, 404, 'User not found.');
    if (target.id === user.id) return sendError(res, 400, 'You cannot reset your own password here.');
    const body = await readJsonBody(req);
    if (!validPassword(body.password)) return sendError(res, 400, 'Password must be 8–128 characters.');
    target.salt = crypto.randomBytes(16).toString('hex');
    target.hash = crypto.scryptSync(body.password, target.salt, 64).toString('hex');
    // Invalidate that user's sessions so the old password stops working everywhere.
    for (const [tok, s] of Object.entries(db.sessions)) {
      if (s.userId === target.id) delete db.sessions[tok];
    }
    saveAll();
    return sendJson(res, 200, { ok: true });
  }

  const userIdMatch = pathname.match(/^\/api\/users\/([0-9a-f]{24})$/);
  if (userIdMatch && req.method === 'DELETE') {
    if (!needPerm('manage_users')) return;
    const target = db.users.find((u) => u.id === userIdMatch[1]);
    if (!target) return sendError(res, 404, 'User not found.');
    if (target.id === user.id) return sendError(res, 400, 'You cannot delete yourself.');
    const remainingAdmins = db.users.filter(
      (u) => u.id !== target.id && can(u, 'manage_roles')
    );
    if (remainingAdmins.length === 0)
      return sendError(res, 400, 'Cannot delete the last user with role management clearance.');
    db.users = db.users.filter((u) => u.id !== target.id);
    for (const [tok, s] of Object.entries(db.sessions)) {
      if (s.userId === target.id) delete db.sessions[tok];
    }
    saveAll();
    return sendJson(res, 200, { ok: true });
  }

  // -- Health ---------------------------------------------------------------
  if (req.method === 'GET' && pathname === '/healthz') {
    return sendJson(res, 200, { ok: true });
  }

  return sendError(res, 404, 'Not found.');
}

// ---------------------------------------------------------------------------
// Static file serving (public/), with path-traversal protection
// ---------------------------------------------------------------------------
function serveStatic(req, res) {
  let p;
  try {
    p = new URL(req.url, 'http://localhost').pathname;
  } catch {
    res.writeHead(400);
    return res.end('bad request');
  }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'X-Content-Type-Options': 'nosniff' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
seedIfEmpty();

const server = http.createServer(async (req, res) => {
  const start = Date.now();
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (pathname === '/healthz' || pathname.startsWith('/api/')) {
      const query = Object.fromEntries(url.searchParams.entries());
      await handleApi(req, res, pathname, query);
    } else if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/archive/')) {
      const ref = decodeURIComponent(pathname.slice('/archive/'.length)).split('/')[0];
      servePermalink(req, res, ref);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res);
    } else {
      sendError(res, 405, 'Method not allowed.');
    }
  } catch (err) {
    const status = err.status || 500;
    if (!res.headersSent) sendError(res, status, status === 500 ? 'Internal error.' : err.message);
  } finally {
    const ms = Date.now() - start;
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} -> ${res.statusCode} (${ms}ms)`);
  }
});

server.listen(PORT, () => {
  console.log(`Obsidian Directorate Terminal listening on port ${PORT}`);
});
