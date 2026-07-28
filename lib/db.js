'use strict';

/**
 * SQLite backend built on node:sqlite (Node >= 22.13 / 23.4, zero deps).
 *
 * Layout:
 *   kv(k, v)                        — the state snapshot (users, servers, ...)
 *   messages(channel_key, id, json, created_at)
 *
 * WAL journaling gives atomic, crash-safe writes; the primary key on
 * (channel_key, id) makes history pagination an index range scan. When
 * node:sqlite is unavailable the caller falls back to the JSON file store,
 * so old Node versions keep working unchanged.
 */

const fs = require('node:fs');
const path = require('node:path');

// Silence only the SQLite experimental notice — everything else passes through.
const realEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  if (String(warning && warning.message ? warning.message : warning).includes('SQLite is an experimental feature')) {
    return;
  }
  return realEmitWarning(warning, ...args);
};

class SqliteBackend {
  constructor(DatabaseSync, dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        channel_key TEXT NOT NULL,
        id TEXT NOT NULL,
        json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (channel_key, id)
      );
    `);

    this.stmt = {
      getKv: this.db.prepare('SELECT v FROM kv WHERE k = ?'),
      setKv: this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
      insertMsg: this.db.prepare('INSERT OR IGNORE INTO messages (channel_key, id, json, created_at) VALUES (?, ?, ?, ?)'),
      updateMsg: this.db.prepare('UPDATE messages SET json = ? WHERE channel_key = ? AND id = ?'),
      getMsg: this.db.prepare('SELECT json FROM messages WHERE channel_key = ? AND id = ?'),
      pageLatest: this.db.prepare('SELECT json FROM messages WHERE channel_key = ? ORDER BY id DESC LIMIT ?'),
      pageBefore: this.db.prepare('SELECT json FROM messages WHERE channel_key = ? AND id < ? ORDER BY id DESC LIMIT ?'),
      lastMsg: this.db.prepare('SELECT json FROM messages WHERE channel_key = ? ORDER BY id DESC LIMIT 1'),
      dropChannel: this.db.prepare('DELETE FROM messages WHERE channel_key = ?'),
      countAll: this.db.prepare('SELECT COUNT(*) AS c FROM messages'),
      countChannel: this.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE channel_key = ?')
    };
  }

  loadState() {
    const row = this.stmt.getKv.get('state');
    if (!row) {
      return null;
    }
    try {
      return JSON.parse(row.v);
    } catch {
      return null;
    }
  }

  saveState(serialized) {
    this.stmt.setKv.run('state', serialized);
  }

  insertMessage(channelKey, message) {
    this.stmt.insertMsg.run(channelKey, message.id, JSON.stringify(message), message.createdAt || 0);
  }

  updateMessage(channelKey, message) {
    this.stmt.updateMsg.run(JSON.stringify(message), channelKey, message.id);
  }

  getMessage(channelKey, messageId) {
    const row = this.stmt.getMsg.get(channelKey, messageId);
    if (!row) {
      return null;
    }
    try {
      return JSON.parse(row.json);
    } catch {
      return null;
    }
  }

  getMessages(channelKey, { beforeId = null, limit = 50 } = {}) {
    const rows = beforeId
      ? this.stmt.pageBefore.all(channelKey, beforeId, limit + 1)
      : this.stmt.pageLatest.all(channelKey, limit + 1);
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const messages = [];
    for (const row of slice) {
      try {
        messages.push(JSON.parse(row.json));
      } catch {}
    }
    messages.reverse(); // oldest first, like the file store
    return { messages, hasMore };
  }

  lastMessageAt(channelKey) {
    const row = this.stmt.lastMsg.get(channelKey);
    if (!row) {
      return 0;
    }
    try {
      return JSON.parse(row.json).createdAt || 0;
    } catch {
      return 0;
    }
  }

  removeChannel(channelKey) {
    this.stmt.dropChannel.run(channelKey);
  }

  totalMessages() {
    return Number(this.stmt.countAll.get().c);
  }

  hasAnyMessages() {
    return this.totalMessages() > 0;
  }

  /** One-time import of the old JSONL event logs. */
  importChannelLog(channelKey, filePath) {
    let raw = '';
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return 0;
    }

    const byId = new Map();
    const order = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.t === 'm' && event.m && event.m.id) {
        if (!byId.has(event.m.id)) {
          byId.set(event.m.id, event.m);
          order.push(event.m.id);
        }
      } else if (event.id && byId.has(event.id)) {
        const target = byId.get(event.id);
        if (event.t === 'e') {
          target.content = event.c;
          target.editedAt = event.ts;
        } else if (event.t === 'd') {
          target.deleted = true;
          target.content = '';
          target.attachments = [];
          target.reactions = {};
        } else if (event.t === 'r') {
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
        }
      }
    }

    this.db.exec('BEGIN');
    try {
      for (const id of order) {
        const message = byId.get(id);
        this.stmt.insertMsg.run(channelKey, id, JSON.stringify(message), message.createdAt || 0);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return order.length;
  }
}

/** Returns a SqliteBackend, or null when node:sqlite is unavailable. */
function openDatabase(baseDir) {
  if (process.env.ROOMLY_DB === 'files') {
    return null; // explicit opt-out
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return null; // older Node: the JSON file store takes over
  }
  try {
    return new SqliteBackend(DatabaseSync, path.join(baseDir, 'roomly.db'));
  } catch (error) {
    console.error('SQLite could not be opened; falling back to the file store:', error.message);
    return null;
  }
}

module.exports = { openDatabase };
