'use strict';

/**
 * Roomly — a Discord-style communication platform that runs anywhere Node runs.
 *
 * Servers -> channels (text + voice/video) -> messages, DMs, roles, invites,
 * presence, screen sharing. One process, one dependency (ws), durable storage
 * on disk. See SCALING.md for the architecture path from this single node to
 * a 1M-user deployment.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { Store } = require('./lib/store');
const { Auth } = require('./lib/auth');
const { Hub } = require('./lib/hub');

const config = {
  host: process.env.HOST || '0.0.0.0',
  port: Number.parseInt(process.env.PORT || '3000', 10),
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  maxVoicePeers: Number.parseInt(process.env.MAX_VOICE_PEERS || '12', 10),
  guestServerTtlMs: Math.max(60_000, Number.parseFloat(process.env.GUEST_SERVER_TTL_HOURS || '24') * 3_600_000) || 24 * 3_600_000,
  maxUploadBytes: Number.parseInt(process.env.MAX_UPLOAD_MB || '10', 10) * 1024 * 1024,
  trustProxy: process.env.TRUST_PROXY === '1',
  iceServers() {
    // Two independent anycast STUN providers: whichever answers first from the
    // user's region wins, and one being unreachable never blocks a call.
    const iceServers = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: ['stun:stun.cloudflare.com:3478'] }
    ];
    if (process.env.TURN_URL) {
      // Your own relay always wins.
      iceServers.push({
        urls: process.env.TURN_URL.split(',').map((url) => url.trim()),
        username: process.env.TURN_USERNAME || '',
        credential: process.env.TURN_CREDENTIAL || ''
      });
    } else if (fetchedTurnServers) {
      // Credentials fetched from a TURN REST API (e.g. a free Metered
      // account) — geographically routed and guaranteed capacity.
      iceServers.push(...fetchedTurnServers);
    } else if (process.env.TURN_DISABLE !== '1') {
      // Zero-config fallback: the Open Relay community TURN uses the TURN
      // REST credential scheme, so we mint short-lived credentials from the
      // published shared secret right here. Relay is what lets calls
      // connect through VPNs, symmetric NATs and strict firewalls — the
      // TLS/TCP 443 variant passes almost anything. Best-effort community
      // capacity: for production, set TURN_REST_API or TURN_URL.
      const username = String(Math.floor(Date.now() / 1000) + 24 * 3600);
      const credential = crypto.createHmac('sha1', 'openrelayprojectsecret')
        .update(username).digest('base64');
      iceServers.push({
        urls: [
          'turn:staticauth.openrelay.metered.ca:80',
          'turn:staticauth.openrelay.metered.ca:443',
          'turn:staticauth.openrelay.metered.ca:443?transport=tcp',
          'turns:staticauth.openrelay.metered.ca:443?transport=tcp'
        ],
        username,
        credential
      });
    }
    return iceServers;
  }
};

// Optional: fetch ready-made TURN credentials from a REST endpoint (set
// TURN_REST_API to e.g. https://<app>.metered.live/api/v1/turn/credentials?apiKey=KEY
// from a free Metered account). Refreshed every 4 hours, cached in memory.
let fetchedTurnServers = null;
async function refreshTurnServers() {
  if (!process.env.TURN_REST_API) {
    return;
  }
  try {
    const response = await fetch(process.env.TURN_REST_API);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const list = await response.json();
    if (Array.isArray(list) && list.length) {
      fetchedTurnServers = list.filter((entry) => entry && entry.urls);
      console.log(`TURN credentials refreshed from API (${fetchedTurnServers.length} entries)`);
    }
  } catch (error) {
    console.error('Could not refresh TURN credentials from TURN_REST_API:', error.message);
  }
}
if (process.env.TURN_REST_API) {
  refreshTurnServers();
  setInterval(refreshTurnServers, 4 * 3600 * 1000).unref();
}

const store = new Store(config.dataDir);
store.init();
const auth = new Auth(store);

// ------------------------------------------------------------------- statics

const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/app.js', 'app.js'],
  ['/admin', 'admin.html'],
  ['/admin.html', 'admin.html'],
  ['/admin.css', 'admin.css'],
  ['/admin-console.js', 'admin-console.js']
]);

const MIME = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8'
}));

// Upload types allowed to render inline in the browser. Everything else is
// forced to download so nobody can serve active content (html/svg) to others.
const INLINE_UPLOAD_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'audio/mpeg', 'audio/wav', 'audio/ogg',
  'video/mp4', 'video/webm',
  'application/pdf', 'text/plain; charset=utf-8'
]);

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; " +
    "img-src 'self' data: blob:; media-src 'self' blob:; " +
    "connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; " +
    "form-action 'self'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self)',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
};

function isSecure(request) {
  if (config.trustProxy) {
    return String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  }
  return false;
}

function sendJson(response, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  response.end(payload);
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('too-large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function readJsonBody(request) {
  const body = await readBody(request, 64 * 1024);
  try {
    const parsed = JSON.parse(body.toString('utf8') || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function serveStatic(request, response, fileName) {
  const filePath = path.join(__dirname, fileName);
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME.get(path.extname(fileName)) || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    response.end(content);
  });
}

// --------------------------------------------------------------------- auth

function currentUser(request) {
  const token = Auth.readCookie(request);
  const resolved = auth.resolve(token);
  return resolved ? { ...resolved, token } : null;
}

const authAttempts = new Map(); // ip -> {count, resetAt}

function tooManyAuthAttempts(request) {
  const ip = config.trustProxy
    ? String(request.headers['x-forwarded-for'] || '').split(',')[0].trim() || request.socket.remoteAddress
    : request.socket.remoteAddress;
  const now = Date.now();
  let entry = authAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 10 * 60 * 1000 };
    authAttempts.set(ip, entry);
  }
  entry.count += 1;
  if (authAttempts.size > 10_000) {
    authAttempts.clear(); // crude memory guard
  }
  return entry.count > 30;
}

async function handleAuthRoute(request, response, pathname) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  if (pathname === '/api/logout') {
    const current = currentUser(request);
    if (current) {
      auth.logout(current.token);
    }
    sendJson(response, 200, { ok: true }, { 'Set-Cookie': Auth.clearCookie() });
    return;
  }

  if (tooManyAuthAttempts(request)) {
    sendJson(response, 429, { error: 'Too many attempts. Wait a few minutes and try again.' });
    return;
  }

  const body = await readJsonBody(request);
  let result;
  if (pathname === '/api/register') {
    result = auth.register(body);
  } else if (pathname === '/api/login') {
    result = auth.login(body);
  } else if (pathname === '/api/guest') {
    result = auth.guest(body);
  } else {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  if (result.error) {
    sendJson(response, 400, { error: result.error });
    return;
  }

  const maxAge = result.session.expiresAt - Date.now();
  sendJson(response, 200, {
    ok: true,
    user: {
      id: result.user.id,
      name: result.user.displayName,
      username: result.user.username,
      guest: result.user.guest
    }
  }, { 'Set-Cookie': Auth.sessionCookie(result.session.token, maxAge, isSecure(request)) });
}

// ------------------------------------------------------------------ uploads

const EXTENSION_PATTERN = /\.[a-zA-Z0-9]{1,8}$/;

async function handleUpload(request, response) {
  const current = currentUser(request);
  if (!current) {
    sendJson(response, 401, { error: 'Sign in to upload files.' });
    return;
  }

  let rawName = '';
  try {
    rawName = Buffer.from(String(request.headers['x-file-name'] || ''), 'base64').toString('utf8');
  } catch {}
  const cleanName = (rawName || 'file')
    .replace(/[\u0000-\u001f\/\\:*?"<>|]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120) || 'file';
  const extensionMatch = cleanName.match(EXTENSION_PATTERN);
  const extension = extensionMatch ? extensionMatch[0].toLowerCase() : '';

  let body;
  try {
    body = await readBody(request, config.maxUploadBytes);
  } catch (error) {
    if (error.message === 'too-large') {
      sendJson(response, 413, { error: `Files can be at most ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.` });
      return;
    }
    sendJson(response, 400, { error: 'Upload failed.' });
    return;
  }
  if (!body.length) {
    sendJson(response, 400, { error: 'The file was empty.' });
    return;
  }

  const id = `${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
  const storedName = `${id}${extension}`;
  await fs.promises.writeFile(path.join(store.uploadsDir, storedName), body);

  sendJson(response, 200, {
    ok: true,
    attachment: {
      url: `/uploads/${storedName}`,
      name: cleanName,
      size: body.length,
      type: MIME.get(extension) || 'application/octet-stream'
    }
  });
}

function serveUpload(request, response, pathname) {
  const current = currentUser(request);
  if (!current) {
    response.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Sign in first');
    return;
  }

  const fileName = pathname.slice('/uploads/'.length);
  if (!/^[a-zA-Z0-9_.-]+$/.test(fileName) || fileName.includes('..')) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const filePath = path.join(store.uploadsDir, fileName);
  if (!filePath.startsWith(store.uploadsDir)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    const type = MIME.get(path.extname(fileName).toLowerCase()) || 'application/octet-stream';
    const inline = INLINE_UPLOAD_TYPES.has(type);
    response.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stats.size,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Disposition': inline ? 'inline' : 'attachment',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'X-Content-Type-Options': 'nosniff'
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    fs.createReadStream(filePath).pipe(response);
  });
}

// ------------------------------------------------------------- admin console

function currentAdmin(request) {
  const current = currentUser(request);
  if (!current || current.user.guest || !current.user.platformAdmin) {
    return null;
  }
  return current;
}

function uploadsUsage() {
  let files = 0;
  let bytes = 0;
  try {
    for (const name of fs.readdirSync(store.uploadsDir)) {
      try {
        const stat = fs.statSync(path.join(store.uploadsDir, name));
        if (stat.isFile()) {
          files += 1;
          bytes += stat.size;
        }
      } catch {}
    }
  } catch {}
  return { files, bytes };
}

async function handleAdminApi(request, response, pathname) {
  const admin = currentAdmin(request);
  if (!admin) {
    sendJson(response, 403, { error: 'Platform admin access required.' });
    return;
  }
  const state = store.state;

  if (pathname === '/api/admin/overview' && request.method === 'GET') {
    const users = Object.values(state.users);
    const servers = Object.values(state.servers);
    sendJson(response, 200, {
      accounts: users.filter((user) => !user.guest).length,
      guests: users.filter((user) => user.guest).length,
      disabled: users.filter((user) => user.disabled).length,
      servers: servers.length,
      tempServers: servers.filter((server) => server.temp).length,
      online: hub.connsByUser.size,
      inVoice: Array.from(hub.voice.values()).reduce((sum, set) => sum + set.size, 0),
      messages: store.backend ? store.backend.totalMessages() : null,
      uploads: uploadsUsage(),
      db: store.backend ? 'sqlite' : 'json-files',
      uptimeSec: Math.floor(process.uptime())
    });
    return;
  }

  if (pathname === '/api/admin/users' && request.method === 'GET') {
    const requestUrl = new URL(request.url, 'http://localhost');
    const query = (requestUrl.searchParams.get('q') || '').toLowerCase();
    const list = Object.values(state.users)
      .filter((user) => !query ||
        (user.username || '').includes(query) ||
        (user.displayName || '').toLowerCase().includes(query))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 500)
      .map((user) => ({
        id: user.id,
        username: user.username,
        name: user.displayName,
        guest: Boolean(user.guest),
        disabled: Boolean(user.disabled),
        platformAdmin: Boolean(user.platformAdmin),
        createdAt: user.createdAt,
        online: hub.connsByUser.has(user.id),
        serversOwned: Object.values(state.servers).filter((server) => server.ownerId === user.id).length
      }));
    sendJson(response, 200, { users: list });
    return;
  }

  if (pathname === '/api/admin/users' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const target = state.users[String(body.userId || '')];
    if (!target) {
      sendJson(response, 404, { error: 'User not found.' });
      return;
    }
    if (target.id === admin.user.id && body.action !== 'demote') {
      sendJson(response, 400, { error: 'Use another admin account to manage your own.' });
      return;
    }
    if (target.platformAdmin && target.id !== admin.user.id) {
      sendJson(response, 400, { error: 'Other platform admins cannot be managed from here.' });
      return;
    }

    switch (body.action) {
      case 'disable':
        target.disabled = true;
        store.markDirty();
        hub.adminDisconnectUser(target.id);
        sendJson(response, 200, { ok: true });
        return;
      case 'enable':
        delete target.disabled;
        store.markDirty();
        sendJson(response, 200, { ok: true });
        return;
      case 'promote':
        if (target.guest) {
          sendJson(response, 400, { error: 'Guests cannot be platform admins.' });
          return;
        }
        target.platformAdmin = true;
        store.markDirty();
        sendJson(response, 200, { ok: true });
        return;
      case 'demote':
        delete target.platformAdmin;
        store.markDirty();
        sendJson(response, 200, { ok: true });
        return;
      case 'reset-password': {
        if (target.guest) {
          sendJson(response, 400, { error: 'Guests have no password.' });
          return;
        }
        const temp = crypto.randomBytes(8).toString('base64url');
        applyPasswordReset(target, temp);
        sendJson(response, 200, { ok: true, tempPassword: temp });
        return;
      }
      case 'delete':
        await hub.adminDeleteUser(target.id);
        sendJson(response, 200, { ok: true });
        return;
      default:
        sendJson(response, 400, { error: 'Unknown action.' });
    }
    return;
  }

  if (pathname === '/api/admin/servers' && request.method === 'GET') {
    const list = Object.values(state.servers)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 500)
      .map((server) => ({
        id: server.id,
        name: server.name,
        icon: server.icon,
        ownerId: server.ownerId,
        ownerName: (state.users[server.ownerId] || {}).displayName || 'unknown',
        members: Object.keys(server.members).length,
        channels: Object.keys(server.channels).length,
        temp: Boolean(server.temp),
        expiresAt: server.expiresAt || null,
        createdAt: server.createdAt
      }));
    sendJson(response, 200, { servers: list });
    return;
  }

  if (pathname === '/api/admin/servers' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const server = state.servers[String(body.serverId || '')];
    if (!server) {
      sendJson(response, 404, { error: 'Server not found.' });
      return;
    }
    if (body.action === 'delete') {
      await hub.destroyServer(server, 'deleted');
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 400, { error: 'Unknown action.' });
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

// ------------------------------------------------------------------- server

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;

  try {
    if (pathname === '/health') {
      sendJson(response, 200, {
        status: 'ok',
        users: Object.keys(store.state.users).length,
        servers: Object.keys(store.state.servers).length,
        online: hub ? hub.connsByUser.size : 0
      });
      return;
    }

    if (pathname.startsWith('/api/admin/')) {
      await handleAdminApi(request, response, pathname);
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/me') {
        const current = currentUser(request);
        if (!current) {
          sendJson(response, 401, { error: 'Not signed in' });
          return;
        }
        sendJson(response, 200, {
          user: {
            id: current.user.id,
            name: current.user.displayName,
            username: current.user.username,
            guest: current.user.guest,
            platformAdmin: Boolean(current.user.platformAdmin)
          }
        });
        return;
      }
      if (pathname === '/api/upload') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'Method not allowed' });
          return;
        }
        await handleUpload(request, response);
        return;
      }
      await handleAuthRoute(request, response, pathname);
      return;
    }

    if (pathname.startsWith('/uploads/')) {
      serveUpload(request, response, pathname);
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end('Method not allowed');
      return;
    }

    // Invite deep links render the app; the client reads the code from the URL.
    if (/^\/invite\/[a-z0-9]+$/i.test(pathname)) {
      serveStatic(request, response, 'index.html');
      return;
    }

    const mapped = STATIC_FILES.get(pathname);
    if (mapped) {
      serveStatic(request, response, mapped);
      return;
    }

    // Client modules and assets: /js/*.js, /assets/*
    if (/^\/js\/[a-z0-9_-]+\.js$/.test(pathname) || /^\/assets\/[a-z0-9_.-]+$/i.test(pathname)) {
      serveStatic(request, response, pathname.slice(1));
      return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    response.end('Not found');
  } catch (error) {
    console.error('Request failed:', error);
    if (!response.headersSent) {
      sendJson(response, 500, { error: 'Internal server error' });
    } else {
      response.end();
    }
  }
});

const hub = new Hub({ server, store, auth, config });

// Grant platform-admin to usernames listed in ADMIN_USERS (comma-separated).
for (const name of String(process.env.ADMIN_USERS || '').split(',')) {
  const user = auth ? store.getUserByUsername(name.trim()) : null;
  if (user && !user.guest && !user.platformAdmin) {
    user.platformAdmin = true;
    store.markDirty();
    console.log(`Granted platform admin to @${user.username}`);
  }
}

function applyPasswordReset(target, tempPassword) {
  const scryptSalt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(tempPassword, scryptSalt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  target.pass = `s1:${scryptSalt.toString('hex')}:${hash.toString('hex')}`;
  // Old sessions die with the old password.
  for (const [token, session] of Object.entries(store.state.sessions)) {
    if (session.userId === target.id) {
      delete store.state.sessions[token];
    }
  }
  store.markDirty();
  hub.adminDisconnectUser(target.id);
  return true;
}

server.listen(config.port, config.host, () => {
  console.log(`Roomly is running at http://localhost:${config.port}`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log('Shutting down...');
  hub.close();
  server.close(() => process.exit(0));
  store.flushSync();
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
