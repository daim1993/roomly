'use strict';

/**
 * Roomly store — durable persistence with zero native dependencies.
 *
 * Layout on disk (created on demand):
 *   data/state.json          — users, sessions, servers, channels, DM threads
 *   data/messages/<key>.jsonl — append-only event log per text channel / DM
 *   data/uploads/            — file attachments (written by server.js)
 *
 * Writes are debounced and atomic (tmp file + rename). Message logs are
 * replayed lazily the first time a channel is read, then kept in memory
 * (bounded window) while the full history stays on disk.
 *
 * This module is the seam for real scale: swap it for a Postgres-backed
 * implementation with the same API (see SCALING.md) without touching hub.js.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { openDatabase } = require('./db');

const STATE_DEBOUNCE_MS = 250;
const STATE_MAX_WAIT_MS = 2000;
const MEMORY_WINDOW = 600; // messages kept in memory per channel
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const GUEST_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function now() {
  return Date.now();
}

/** Sortable unique id: millisecond timestamp base36 + random suffix. */
function makeId(prefix = '') {
  const ts = now().toString(36).padStart(9, '0');
  const rand = crypto.randomBytes(5).toString('hex');
  return prefix ? `${prefix}_${ts}${rand}` : `${ts}${rand}`;
}

function token() {
  return crypto.randomBytes(32).toString('base64url');
}

function safeFileKey(channelKey) {
  return channelKey.replace(/[^a-zA-Z0-9_-]/g, '-');
}

class ChannelLog {
  constructor(filePath) {
    this.filePath = filePath;
    this.loaded = false;
    this.messages = []; // ordered by id (time)
    this.byId = new Map();
    this.totalOnDisk = 0;
    this.writeChain = Promise.resolve();
  }

  load() {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    let raw = '';
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return; // no history yet
    }

    for (const line of raw.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // tolerate a torn final line after a crash
      }
      this.applyToMemory(event, true);
    }
    this.trim();
  }

  applyToMemory(event, replaying = false) {
    if (!event || typeof event !== 'object') {
      return null;
    }

    if (event.t === 'm' && event.m && event.m.id) {
      if (this.byId.has(event.m.id)) {
        return null;
      }
      this.messages.push(event.m);
      this.byId.set(event.m.id, event.m);
      this.totalOnDisk += replaying ? 1 : 0;
      return event.m;
    }

    const target = this.byId.get(event.id);
    if (!target) {
      return null;
    }

    if (event.t === 'e') {
      target.content = event.c;
      target.editedAt = event.ts;
      if (event.men) {
        target.mentions = event.men;
      }
      return target;
    }
    if (event.t === 'd') {
      target.deleted = true;
      target.content = '';
      target.attachments = [];
      target.reactions = {};
      return target;
    }
    if (event.t === 'r') {
      const reactions = target.reactions || (target.reactions = {});
      const users = new Set(reactions[event.e] || []);
      if (event.on) {
        users.add(event.u);
      } else {
        users.delete(event.u);
      }
      if (users.size) {
        reactions[event.e] = Array.from(users);
      } else {
        delete reactions[event.e];
      }
      return target;
    }
    return null;
  }

  trim() {
    if (this.messages.length > MEMORY_WINDOW) {
      const removed = this.messages.splice(0, this.messages.length - MEMORY_WINDOW);
      for (const message of removed) {
        this.byId.delete(message.id);
      }
    }
  }

  append(event) {
    const result = this.applyToMemory(event);
    this.trim();
    const line = `${JSON.stringify(event)}\n`;
    this.writeChain = this.writeChain
      .then(() => fsp.appendFile(this.filePath, line, 'utf8'))
      .catch((error) => {
        console.error(`Could not persist message event for ${path.basename(this.filePath)}:`, error.message);
      });
    return result;
  }
}

class Store {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.messagesDir = path.join(baseDir, 'messages');
    this.uploadsDir = path.join(baseDir, 'uploads');
    this.statePath = path.join(baseDir, 'state.json');
    this.stateTmpPath = path.join(baseDir, 'state.json.tmp');

    this.state = {
      users: {},
      usernames: {}, // lowercase username -> userId
      sessions: {},
      servers: {},
      invites: {}, // inviteCode -> serverId
      dms: {}
    };

    this.logs = new Map(); // channelKey -> ChannelLog
    this.saveTimer = null;
    this.firstDirtyAt = 0;
    this.saving = Promise.resolve();
  }

  init() {
    fs.mkdirSync(this.messagesDir, { recursive: true });
    fs.mkdirSync(this.uploadsDir, { recursive: true });

    this.backend = openDatabase(this.baseDir);

    const applyParsed = (parsed) => {
      this.state = {
        users: parsed.users || {},
        usernames: parsed.usernames || {},
        sessions: parsed.sessions || {},
        servers: parsed.servers || {},
        invites: parsed.invites || {},
        dms: parsed.dms || {}
      };
    };

    if (this.backend) {
      const dbState = this.backend.loadState();
      if (dbState) {
        applyParsed(dbState);
      } else {
        // First boot on SQLite: migrate the old JSON snapshot if one exists.
        try {
          applyParsed(JSON.parse(fs.readFileSync(this.statePath, 'utf8')));
          console.log('Migrated state.json into SQLite.');
        } catch {}
        this.backend.saveState(JSON.stringify(this.state));
      }
      this.migrateMessageLogs();
      console.log('Storage engine: SQLite (data/roomly.db)');
    } else {
      try {
        applyParsed(JSON.parse(fs.readFileSync(this.statePath, 'utf8')));
      } catch (error) {
        if (error.code !== 'ENOENT') {
          // Corrupt state file: keep it aside instead of overwriting evidence.
          try {
            fs.renameSync(this.statePath, `${this.statePath}.corrupt-${now()}`);
          } catch {}
          console.error('State file could not be read; starting from a fresh state:', error.message);
        }
      }
      console.log('Storage engine: JSON files (upgrade Node to 22.13+ for SQLite)');
    }

    this.pruneSessions();
  }

  /** One-time import of legacy JSONL message logs into SQLite. */
  migrateMessageLogs() {
    if (this.backend.hasAnyMessages()) {
      return;
    }
    let files = [];
    try {
      files = fs.readdirSync(this.messagesDir).filter((name) => name.endsWith('.jsonl'));
    } catch {
      return;
    }
    let total = 0;
    for (const file of files) {
      // File names never contain '-' inside ids, so this mapping is exact.
      const parts = file.replace(/\.jsonl$/, '').split('-');
      let channelKey = null;
      if (parts[0] === 'srv' && parts.length === 3) {
        channelKey = `srv:${parts[1]}:${parts[2]}`;
      } else if (parts[0] === 'dm' && parts.length === 2) {
        channelKey = `dm:${parts[1]}`;
      }
      if (channelKey) {
        total += this.backend.importChannelLog(channelKey, path.join(this.messagesDir, file));
      }
    }
    if (total) {
      console.log(`Migrated ${total} messages from JSONL logs into SQLite.`);
    }
  }

  // ---------------------------------------------------------------- state io

  markDirty() {
    if (!this.firstDirtyAt) {
      this.firstDirtyAt = now();
    }
    if (this.saveTimer) {
      if (now() - this.firstDirtyAt >= STATE_MAX_WAIT_MS) {
        clearTimeout(this.saveTimer);
        this.flush();
      }
      return;
    }
    this.saveTimer = setTimeout(() => this.flush(), STATE_DEBOUNCE_MS);
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.firstDirtyAt = 0;
    const payload = JSON.stringify(this.state);
    if (this.backend) {
      try {
        this.backend.saveState(payload);
      } catch (error) {
        console.error('Could not persist state to SQLite:', error.message);
      }
      return this.saving;
    }
    this.saving = this.saving
      .then(async () => {
        await fsp.writeFile(this.stateTmpPath, payload, 'utf8');
        await fsp.rename(this.stateTmpPath, this.statePath);
      })
      .catch((error) => {
        console.error('Could not persist state:', error.message);
      });
    return this.saving;
  }

  flushSync() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.backend) {
      try {
        this.backend.saveState(JSON.stringify(this.state));
      } catch (error) {
        console.error('Could not persist state on shutdown:', error.message);
      }
      return;
    }
    try {
      fs.writeFileSync(this.stateTmpPath, JSON.stringify(this.state), 'utf8');
      fs.renameSync(this.stateTmpPath, this.statePath);
    } catch (error) {
      console.error('Could not persist state on shutdown:', error.message);
    }
  }

  // ------------------------------------------------------------------- users

  createUser({ username, displayName, passHash, guest }) {
    const user = {
      id: makeId('u'),
      username: username || null,
      displayName,
      pass: passHash || null,
      guest: Boolean(guest),
      color: 1 + (crypto.randomBytes(1)[0] % 8),
      createdAt: now(),
      lastRead: {}
    };
    this.state.users[user.id] = user;
    if (username) {
      this.state.usernames[username.toLowerCase()] = user.id;
    }
    this.markDirty();
    return user;
  }

  getUser(userId) {
    return this.state.users[userId] || null;
  }

  getUserByUsername(username) {
    const id = this.state.usernames[String(username || '').toLowerCase()];
    return id ? this.getUser(id) : null;
  }

  // ---------------------------------------------------------------- sessions

  createSession(userId, guest = false) {
    const session = {
      token: token(),
      userId,
      createdAt: now(),
      expiresAt: now() + (guest ? GUEST_SESSION_TTL_MS : SESSION_TTL_MS)
    };
    this.state.sessions[session.token] = session;
    this.markDirty();
    return session;
  }

  getSession(sessionToken) {
    const session = this.state.sessions[sessionToken];
    if (!session) {
      return null;
    }
    if (session.expiresAt < now()) {
      delete this.state.sessions[sessionToken];
      this.markDirty();
      return null;
    }
    return session;
  }

  deleteSession(sessionToken) {
    if (this.state.sessions[sessionToken]) {
      delete this.state.sessions[sessionToken];
      this.markDirty();
    }
  }

  pruneSessions() {
    const cutoff = now();
    let removed = 0;
    for (const [key, session] of Object.entries(this.state.sessions)) {
      if (session.expiresAt < cutoff) {
        delete this.state.sessions[key];
        removed += 1;
      }
    }
    if (removed) {
      this.markDirty();
    }
  }

  // ---------------------------------------------------------------- messages

  log(channelKey) {
    let log = this.logs.get(channelKey);
    if (!log) {
      log = new ChannelLog(path.join(this.messagesDir, `${safeFileKey(channelKey)}.jsonl`));
      this.logs.set(channelKey, log);
    }
    log.load();
    return log;
  }

  appendMessage(channelKey, message) {
    if (this.backend) {
      this.backend.insertMessage(channelKey, message);
      return message;
    }
    return this.log(channelKey).append({ t: 'm', m: message });
  }

  editMessage(channelKey, messageId, content, ts, mentions = null) {
    if (this.backend) {
      const message = this.backend.getMessage(channelKey, messageId);
      if (!message) {
        return null;
      }
      message.content = content;
      message.editedAt = ts;
      if (mentions) {
        message.mentions = mentions;
      }
      this.backend.updateMessage(channelKey, message);
      return message;
    }
    return this.log(channelKey).append({ t: 'e', id: messageId, c: content, ts, men: mentions || undefined });
  }

  deleteMessage(channelKey, messageId) {
    if (this.backend) {
      const message = this.backend.getMessage(channelKey, messageId);
      if (!message) {
        return null;
      }
      message.deleted = true;
      message.content = '';
      message.attachments = [];
      message.reactions = {};
      this.backend.updateMessage(channelKey, message);
      return message;
    }
    return this.log(channelKey).append({ t: 'd', id: messageId });
  }

  setReaction(channelKey, messageId, emoji, userId, on) {
    if (this.backend) {
      const message = this.backend.getMessage(channelKey, messageId);
      if (!message) {
        return null;
      }
      const reactions = message.reactions || (message.reactions = {});
      const users = new Set(reactions[emoji] || []);
      if (on) {
        users.add(userId);
      } else {
        users.delete(userId);
      }
      if (users.size) {
        reactions[emoji] = Array.from(users);
      } else {
        delete reactions[emoji];
      }
      this.backend.updateMessage(channelKey, message);
      return message;
    }
    return this.log(channelKey).append({ t: 'r', id: messageId, e: emoji, u: userId, on: Boolean(on) });
  }

  getMessage(channelKey, messageId) {
    if (this.backend) {
      return this.backend.getMessage(channelKey, messageId);
    }
    return this.log(channelKey).byId.get(messageId) || null;
  }

  /** Returns up to `limit` messages before `beforeId` (exclusive). */
  getMessages(channelKey, { beforeId = null, limit = 50 } = {}) {
    if (this.backend) {
      return this.backend.getMessages(channelKey, { beforeId, limit });
    }
    const log = this.log(channelKey);
    let end = log.messages.length;
    if (beforeId) {
      const index = log.messages.findIndex((message) => message.id === beforeId);
      if (index >= 0) {
        end = index;
      } else if (beforeId <= (log.messages[0] ? log.messages[0].id : '')) {
        end = 0; // asked for history older than the in-memory window
      }
    }
    const start = Math.max(0, end - limit);
    return {
      messages: log.messages.slice(start, end),
      hasMore: start > 0
    };
  }

  lastMessageAt(channelKey) {
    if (this.backend) {
      return this.backend.lastMessageAt(channelKey);
    }
    const log = this.log(channelKey);
    const last = log.messages[log.messages.length - 1];
    return last ? last.createdAt : 0;
  }

  async removeChannelLog(channelKey) {
    if (this.backend) {
      this.backend.removeChannel(channelKey);
      return;
    }
    const log = this.logs.get(channelKey);
    this.logs.delete(channelKey);
    const filePath = log
      ? log.filePath
      : path.join(this.messagesDir, `${safeFileKey(channelKey)}.jsonl`);
    try {
      await fsp.rm(filePath, { force: true });
    } catch {}
  }

  makeId(prefix) {
    return makeId(prefix);
  }
}

module.exports = { Store, makeId, token };
