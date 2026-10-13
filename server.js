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

const CLASSIFICATIONS = ['UNCLASSIFIED', 'RESTRICTED', 'CONFIDENTIAL', 'SECRET', 'TOP SECRET'];
const REPORT_TYPES = ['SOS', 'Intelligence Report', 'Diplomatic Communique'];
const SUBTYPES = {
  'Intelligence Report': ['Espionage Attempt', 'CMDR Sighting', 'BGS/PowerPlay', 'Market Changes'],
};
const PERMISSIONS = [
  'view_classified',
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
};

function saveAll() {
  saveJson('users.json', db.users);
  saveJson('roles.json', db.roles);
  saveJson('reports.json', db.reports);
  saveJson('sessions.json', db.sessions);
}

function rid() {
  return crypto.randomBytes(12).toString('hex');
}

// ---------------------------------------------------------------------------
// First-run seeding: roles + admin user with a RANDOM password
// ---------------------------------------------------------------------------
function seedIfEmpty() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (db.roles.length === 0) {
    const all = Object.fromEntries(PERMISSIONS.map((p) => [p, true]));
    const none = Object.fromEntries(PERMISSIONS.map((p) => [p, false]));
    db.roles.push(
      { id: rid(), name: 'Director', permissions: { ...all } },
      {
        id: rid(),
        name: 'Officer',
        permissions: { ...all, manage_users: false, manage_roles: false },
      },
      {
        id: rid(),
        name: 'Operative',
        permissions: { ...none, view_classified: true, create_report: true },
      },
      { id: rid(), name: 'Guest', permissions: { ...none } }
    );
  }

  if (db.users.length === 0) {
    let directorRole = db.roles.find((r) => r.name === 'Director');
    if (!directorRole) {
      // Pathological state: users empty but no Director role. Repair it.
      directorRole = { id: rid(), name: 'Director', permissions: Object.fromEntries(PERMISSIONS.map((p) => [p, true])) };
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

// Validate a report payload. Returns { ok, value } or { ok:false, error }.
function validateReportPayload(body) {
  const cmdr = isStr(body.cmdr) ? body.cmdr.trim().slice(0, 64) : '';
  const title = isStr(body.title) ? body.title.trim() : '';
  const classification = body.classification;
  const type = body.type;
  const bodyText = isStr(body.body) ? body.body : '';

  if (!title || title.length > 200) return { ok: false, error: 'Title is required (max 200 chars).' };
  if (!CLASSIFICATIONS.includes(classification))
    return { ok: false, error: 'Invalid classification.' };
  if (!REPORT_TYPES.includes(type)) return { ok: false, error: 'Invalid report type.' };
  if (!bodyText.trim() || bodyText.length > 20000)
    return { ok: false, error: 'Report body is required (max 20000 chars).' };

  let subtype = null;
  let recipient = null;

  if (type === 'Intelligence Report') {
    if (!SUBTYPES[type].includes(body.subtype))
      return { ok: false, error: 'A valid intelligence subtype is required.' };
    subtype = body.subtype;
  } else if (body.subtype != null && body.subtype !== '') {
    return { ok: false, error: 'Subtype is only valid for Intelligence Reports.' };
  }

  if (type === 'Diplomatic Communique') {
    recipient = isStr(body.recipient) ? body.recipient.trim() : '';
    if (!recipient || recipient.length > 200)
      return { ok: false, error: 'Recipient party is required (max 200 chars).' };
  } else if (body.recipient != null && String(body.recipient).trim() !== '') {
    return { ok: false, error: 'Recipient party is only valid for Diplomatic Communiques.' };
  }

  return { ok: true, value: { cmdr, title, classification, type, subtype, recipient, body: bodyText } };
}

function visibleReports(user) {
  const list = user && can(user, 'view_classified')
    ? db.reports
    : db.reports.filter((r) => r.classification === 'UNCLASSIFIED');
  return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
        (r.cmdr || '').toLowerCase().includes(q)
    );
  }
  return out;
}

function publicReport(r) {
  const { id, cmdr, title, classification, type, subtype, recipient, body, authorUsername, createdAt, updatedAt } = r;
  return { id, cmdr, title, classification, type, subtype, recipient, body, authorUsername, createdAt, updatedAt };
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

  // -- Auth ---------------------------------------------------------------
  if (req.method === 'POST' && pathname === '/api/register') {
    const body = await readJsonBody(req);
    const username = isStr(body.username) ? body.username.trim() : '';
    const password = body.password;
    const cmdr = isStr(body.cmdr) ? body.cmdr.trim().slice(0, 64) : '';
    if (!validUsername(username))
      return sendError(res, 400, 'Username must be 3–24 chars: letters, numbers, _ or -.');
    if (!validPassword(password))
      return sendError(res, 400, 'Password must be 8–128 characters.');
    if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase()))
      return sendError(res, 409, 'Username is already taken.');

    // First user ever becomes Director; everyone else starts as Operative.
    const roleName = db.users.length === 0 ? 'Director' : 'Operative';
    const role = db.roles.find((r) => r.name === roleName) || db.roles[0];
    if (!role) return sendError(res, 500, 'No roles configured.');

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    const newUser = {
      id: rid(),
      username,
      cmdr,
      salt,
      hash,
      roleId: role.id,
      createdAt: new Date().toISOString(),
    };
    db.users.push(newUser);
    const token = createSession(newUser.id);
    saveAll();
    setSessionCookie(res, token);
    return sendJson(res, 201, { user: publicUser(newUser) });
  }

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
    // PUBLIC: UNCLASSIFIED reports only, no auth required.
    const list = db.reports
      .filter((r) => r.classification === 'UNCLASSIFIED')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return sendJson(res, 200, { reports: applyReportFilters(list, query).map(publicReport) });
  }

  if (req.method === 'GET' && pathname === '/api/reports') {
    const list = applyReportFilters(visibleReports(user), query);
    return sendJson(res, 200, { reports: list.map(publicReport) });
  }

  if (req.method === 'POST' && pathname === '/api/reports') {
    if (!needPerm('create_report')) return;
    const body = await readJsonBody(req);
    const v = validateReportPayload(body);
    if (!v.ok) return sendError(res, 400, v.error);
    const now = new Date().toISOString();
    const report = {
      id: rid(),
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
    const canSee =
      report &&
      (report.classification === 'UNCLASSIFIED' || (user && can(user, 'view_classified')));
    if (!canSee) return sendError(res, 404, 'Report not found.');

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
      Object.assign(report, v.value, { updatedAt: new Date().toISOString() });
      saveJson('reports.json', db.reports);
      return sendJson(res, 200, { report: publicReport(report) });
    }

    if (req.method === 'DELETE') {
      if (!needPerm('delete_report')) return;
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
      const permissions = {};
      for (const p of PERMISSIONS) permissions[p] = !!(body.permissions && body.permissions[p]);
      const role = { id: rid(), name, permissions };
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
      if (body.permissions && typeof body.permissions === 'object') {
        for (const p of PERMISSIONS) role.permissions[p] = !!body.permissions[p];
      }
      saveJson('roles.json', db.roles);
      return sendJson(res, 200, { role });
    }
    if (req.method === 'DELETE') {
      if (role.name === 'Director') return sendError(res, 400, 'The Director role cannot be deleted.');
      if (db.users.some((u) => u.roleId === role.id))
        return sendError(res, 400, 'Role is assigned to users. Reassign them first.');
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
    if (url.pathname === '/healthz' || url.pathname.startsWith('/api/')) {
      const query = Object.fromEntries(url.searchParams.entries());
      await handleApi(req, res, url.pathname, query);
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
