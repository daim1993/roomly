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
    const iceServers = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
    ];
    if (process.env.TURN_URL) {
      iceServers.push({
        urls: process.env.TURN_URL.split(',').map((url) => url.trim()),
        username: process.env.TURN_USERNAME || '',
        credential: process.env.TURN_CREDENTIAL || ''
      });
    }
    return iceServers;
  }
};

const store = new Store(config.dataDir);
store.init();
const auth = new Auth(store);

// ------------------------------------------------------------------- statics

const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/app.js', 'app.js']
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
            guest: current.user.guest
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
