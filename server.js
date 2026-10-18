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
const REPORT_TYPES = ['SOS', 'Intelligence Report', 'Diplomatic Communique', 'Directive Orders'];
const SUBTYPES = {
  'Intelligence Report': ['Espionage Attempt', 'CMDR Sighting', 'BGS/PowerPlay', 'Market Changes'],
  'Directive Orders': ['Power Play', 'General BGS'],
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
  '.svg': 'application/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
