'use strict';

/**
 * Roomly realtime hub.
 *
 * One WebSocket per client. The client authenticates via its session cookie
 * during the HTTP upgrade; the hub then sends a full `ready` snapshot and
 * exchanges small JSON events after that.
 *
 * Client -> server requests carry an `op` and optional `req` id; the hub
 * answers with `{t:'ack', req, ok, ...}` and pushes broadcast events to every
 * connection that is allowed to see them. Authorization is enforced here on
 * every operation — never trust the client's view of its own role.
 */

const { WebSocket, WebSocketServer } = require('ws');

const LIMITS = {
  content: 4000,
  serverName: 50,
  channelName: 32,
  topic: 250,
  emoji: 24,
  attachmentsPerMessage: 6,
  serversPerUser: 50,
  channelsPerServer: 60,
  messageHistoryPage: 60
};

const ROLE_RANK = { member: 0, admin: 1, owner: 2 };

function nowMs() {
  return Date.now();
}

function sanitizeText(value, max) {
  // Strip control characters except newline and tab, then cap the length.
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .slice(0, max);
}

function normalizeChannelName(value) {
  return sanitizeText(value, LIMITS.channelName)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-\s_]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function extractMentions(content) {
  const ids = new Set();
  const pattern = /<@(u_[a-z0-9]+)>/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    ids.add(match[1]);
    if (ids.size >= 20) {
      break;
    }
  }
  return Array.from(ids);
}

class Bucket {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.count = 0;
    this.resetAt = 0;
  }

  take() {
    const now = nowMs();
    if (now > this.resetAt) {
      this.resetAt = now + this.windowMs;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= this.limit;
  }
}

class Hub {
  constructor({ server, store, auth, config }) {
    this.store = store;
    this.auth = auth;
    this.config = config;

    this.conns = new Map(); // connId -> conn
    this.connsByUser = new Map(); // userId -> Set<conn>
    this.userServers = new Map(); // userId -> Set<serverId>
    this.voice = new Map(); // channelKey -> Map<connId, participant>

    this.buildMembershipIndex();

    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      const token = require('./auth').Auth.readCookie(request);
      const resolved = this.auth.resolve(token);
      if (!resolved) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.onConnection(ws, resolved.user);
      });
    });

    this.heartbeat = setInterval(() => {
      for (const conn of this.conns.values()) {
        if (!conn.alive) {
          conn.ws.terminate();
          continue;
        }
        conn.alive = false;
        conn.ws.ping();
      }
      this.store.pruneSessions();
    }, 30_000);
    this.heartbeat.unref();

    this.sweeper = setInterval(() => this.sweepExpiredServers(), 10_000);
    this.sweeper.unref();
  }

  buildMembershipIndex() {
    for (const server of Object.values(this.store.state.servers)) {
      for (const userId of Object.keys(server.members)) {
        this.indexMembership(userId, server.id);
      }
    }
  }

  indexMembership(userId, serverId) {
    let set = this.userServers.get(userId);
    if (!set) {
      set = new Set();
      this.userServers.set(userId, set);
    }
    set.add(serverId);
  }

  unindexMembership(userId, serverId) {
    const set = this.userServers.get(userId);
    if (set) {
      set.delete(serverId);
      if (!set.size) {
        this.userServers.delete(userId);
      }
    }
  }

  // ------------------------------------------------------------ connections

  onConnection(ws, user) {
    const conn = {
      id: this.store.makeId('c'),
      ws,
      userId: user.id,
      alive: true,
      voiceKey: null,
      typing: new Map(),
      buckets: {
        general: new Bucket(40, 5000),
        send: new Bucket(12, 5000),
        signal: new Bucket(400, 5000),
        heavy: new Bucket(10, 10_000)
      }
    };

    this.conns.set(conn.id, conn);
    let set = this.connsByUser.get(user.id);
    const firstConnection = !set || !set.size;
    if (!set) {
      set = new Set();
      this.connsByUser.set(user.id, set);
    }
    set.add(conn);

    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('message', (raw) => this.onMessage(conn, raw));
    ws.on('close', () => this.onClose(conn));
    ws.on('error', () => ws.terminate());

    this.sendReady(conn);
    if (firstConnection) {
      this.broadcastPresence(user.id, true);
    }
  }

  onClose(conn) {
    this.conns.delete(conn.id);
    const set = this.connsByUser.get(conn.userId);
    if (set) {
      set.delete(conn);
      if (!set.size) {
        this.connsByUser.delete(conn.userId);
        this.broadcastPresence(conn.userId, false);
      }
    }
    this.leaveVoice(conn);
  }

  send(conn, message) {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(message));
    }
  }

  ack(conn, req, ok, data = {}, error = null) {
    if (req === undefined || req === null) {
      return;
    }
    const payload = { t: 'ack', req, ok, ...data };
    if (error) {
      payload.error = error;
    }
    this.send(conn, payload);
  }

  // -------------------------------------------------------------- audiences

  userConns(userId) {
    return this.connsByUser.get(userId) || new Set();
  }

  sendToUser(userId, message) {
    const serialized = JSON.stringify(message);
    for (const conn of this.userConns(userId)) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(serialized);
      }
    }
  }

  serverAudience(serverId) {
    const server = this.store.state.servers[serverId];
    const conns = [];
    if (!server) {
      return conns;
    }
    for (const userId of Object.keys(server.members)) {
      for (const conn of this.userConns(userId)) {
        conns.push(conn);
      }
    }
    return conns;
  }

  broadcastToServer(serverId, message, excludeConn = null) {
    const serialized = JSON.stringify(message);
    for (const conn of this.serverAudience(serverId)) {
      if (conn !== excludeConn && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(serialized);
      }
    }
  }

  channelAudienceIds(channelKey) {
    if (channelKey.startsWith('dm:')) {
      const dm = this.store.state.dms[channelKey.slice(3)];
      return dm ? dm.users.slice() : [];
    }
    if (channelKey.startsWith('srv:')) {
      const [, serverId] = channelKey.split(':');
      const server = this.store.state.servers[serverId];
      return server ? Object.keys(server.members) : [];
    }
    return [];
  }

  broadcastToChannel(channelKey, message, excludeConn = null) {
    const serialized = JSON.stringify(message);
    for (const userId of this.channelAudienceIds(channelKey)) {
      for (const conn of this.userConns(userId)) {
        if (conn !== excludeConn && conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.send(serialized);
        }
      }
    }
  }

  /** Everyone who shares a server or a DM thread with this user, plus self. */
  relatedUserIds(userId) {
    const ids = new Set([userId]);
    for (const serverId of this.userServers.get(userId) || []) {
      const server = this.store.state.servers[serverId];
      if (server) {
        for (const memberId of Object.keys(server.members)) {
          ids.add(memberId);
        }
      }
    }
    for (const dm of Object.values(this.store.state.dms)) {
      if (dm.users.includes(userId)) {
        for (const id of dm.users) {
          ids.add(id);
        }
      }
    }
    return ids;
  }

  broadcastPresence(userId, online) {
    const message = { t: 'presence', userId, online };
    for (const id of this.relatedUserIds(userId)) {
      if (id !== userId) {
        this.sendToUser(id, message);
      }
    }
  }

  broadcastUserUpdated(userId) {
    const user = this.store.getUser(userId);
    if (!user) {
      return;
    }
    const message = { t: 'user-updated', user: this.publicUser(user) };
    for (const id of this.relatedUserIds(userId)) {
      this.sendToUser(id, message);
    }
  }

  // ------------------------------------------------------------------ views

  publicUser(user) {
    return {
      id: user.id,
      name: user.displayName,
      username: user.username,
      color: user.color,
      guest: Boolean(user.guest)
    };
  }

  serverView(server, forUserId) {
    const me = server.members[forUserId];
    const role = me ? me.role : null;
    const view = {
      id: server.id,
      name: server.name,
      icon: server.icon,
      ownerId: server.ownerId,
      inviteCode: server.inviteCode,
      createdAt: server.createdAt,
      temp: Boolean(server.temp),
      expiresAt: server.expiresAt || null,
      myRole: role,
      members: Object.entries(server.members).map(([userId, member]) => ({
        userId,
        role: member.role,
        joinedAt: member.joinedAt
      })),
      channels: Object.values(server.channels)
        .sort((a, b) => a.position - b.position || (a.createdAt - b.createdAt))
        .map((channel) => ({ ...channel }))
    };
    if (role === 'owner' || role === 'admin') {
      view.bans = Object.keys(server.bans || {});
    }
    return view;
  }

  dmView(dm, forUserId) {
    return {
      id: dm.id,
      otherUserId: dm.users.find((id) => id !== forUserId) || forUserId,
      createdAt: dm.createdAt,
      lastAt: dm.lastAt || 0
    };
  }

  voiceSnapshot() {
    const snapshot = {};
    for (const [channelKey, participants] of this.voice) {
      snapshot[channelKey] = Array.from(participants.values());
    }
    return snapshot;
  }

  sendReady(conn) {
    const user = this.store.getUser(conn.userId);
    const servers = [];
    const users = {};
    const online = [];

    users[user.id] = this.publicUser(user);

    for (const serverId of this.userServers.get(user.id) || []) {
      const server = this.store.state.servers[serverId];
      if (!server) {
        continue;
      }
      servers.push(this.serverView(server, user.id));
      for (const memberId of Object.keys(server.members)) {
        const member = this.store.getUser(memberId);
        if (member) {
          users[memberId] = this.publicUser(member);
        }
      }
    }

    const dms = [];
    for (const dm of Object.values(this.store.state.dms)) {
      if (dm.users.includes(user.id)) {
        dms.push(this.dmView(dm, user.id));
        for (const id of dm.users) {
          const other = this.store.getUser(id);
          if (other) {
            users[id] = this.publicUser(other);
          }
        }
      }
    }

    for (const userId of Object.keys(users)) {
      if (this.connsByUser.has(userId)) {
        online.push(userId);
      }
    }

    // Mention counts for channels with activity since the user's last read.
    const mentions = {};
    const lastRead = user.lastRead || {};
    const checkChannel = (channelKey, lastAt) => {
      const readAt = lastRead[channelKey] || 0;
      if (!lastAt || lastAt <= readAt) {
        return;
      }
      const { messages } = this.store.getMessages(channelKey, { limit: 200 });
      let count = 0;
      for (const message of messages) {
        if (message.createdAt > readAt && !message.deleted &&
            Array.isArray(message.mentions) && message.mentions.includes(user.id)) {
          count += 1;
        }
      }
      if (count) {
        mentions[channelKey] = count;
      }
    };
    for (const server of servers) {
      for (const channel of server.channels) {
        if (channel.type === 'text') {
          checkChannel(`srv:${server.id}:${channel.id}`, channel.lastAt || 0);
        }
      }
    }
    for (const dm of dms) {
      checkChannel(`dm:${dm.id}`, dm.lastAt || 0);
    }

    this.send(conn, {
      t: 'ready',
      connId: conn.id,
      you: { ...this.publicUser(user), lastRead },
      servers,
      dms,
      users,
      online,
      mentions,
      voice: this.voiceSnapshot(),
      voiceLimit: this.config.maxVoicePeers,
      guestTtlHours: Math.round((this.config.guestServerTtlMs / 3_600_000) * 10) / 10,
      iceServers: this.config.iceServers()
    });
  }

  // ------------------------------------------------------------- op routing

  onMessage(conn, raw) {
    if (raw.length > 256 * 1024) {
      return;
    }
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message || typeof message.op !== 'string') {
      return;
    }

    const op = message.op;
    const bucket =
      op === 'signal' ? conn.buckets.signal
      : op === 'send' ? conn.buckets.send
      : (op === 'create-server' || op === 'create-channel' || op === 'messages') ? conn.buckets.heavy
      : conn.buckets.general;

    if (!bucket.take()) {
      this.ack(conn, message.req, false, {}, 'You are doing that too fast. Give it a moment.');
      return;
    }

    const handler = this.handlers()[op];
    if (!handler) {
      this.ack(conn, message.req, false, {}, 'Unknown operation.');
      return;
    }

    try {
      handler.call(this, conn, message);
    } catch (error) {
      console.error(`Error handling op "${op}":`, error);
      this.ack(conn, message.req, false, {}, 'Something went wrong on the server.');
    }
  }

  handlers() {
    if (!this._handlers) {
      this._handlers = {
        'ping': (conn, m) => this.ack(conn, m.req, true, { pong: nowMs() }),
        'create-server': this.opCreateServer,
        'update-server': this.opUpdateServer,
        'delete-server': this.opDeleteServer,
        'leave-server': this.opLeaveServer,
        'join-invite': this.opJoinInvite,
        'regen-invite': this.opRegenInvite,
        'create-channel': this.opCreateChannel,
        'update-channel': this.opUpdateChannel,
        'delete-channel': this.opDeleteChannel,
        'kick': this.opKick,
        'ban': this.opBan,
        'unban': this.opUnban,
        'set-role': this.opSetRole,
        'messages': this.opMessages,
        'send': this.opSend,
        'edit': this.opEdit,
        'del-msg': this.opDeleteMessage,
        'react': this.opReact,
        'typing': this.opTyping,
        'read': this.opRead,
        'find-user': this.opFindUser,
        'dm-open': this.opDmOpen,
        'profile': this.opProfile,
        'voice-join': this.opVoiceJoin,
        'voice-leave': (conn, m) => {
          this.leaveVoice(conn);
          this.ack(conn, m.req, true);
        },
        'voice-media': this.opVoiceMedia,
        'signal': this.opSignal
      };
    }
    return this._handlers;
  }

  // ----------------------------------------------------------- server admin

  requireServer(conn, serverId) {
    const server = this.store.state.servers[serverId];
    if (!server || !server.members[conn.userId]) {
      return null;
    }
    return server;
  }

  roleOf(server, userId) {
    const member = server.members[userId];
    return member ? member.role : null;
  }

  canModerate(server, actorId, targetId) {
    const actorRank = ROLE_RANK[this.roleOf(server, actorId)] ?? -1;
    const targetRank = ROLE_RANK[this.roleOf(server, targetId)] ?? 0;
    return actorRank >= 1 && actorRank > targetRank && actorId !== targetId;
  }

  opCreateServer(conn, m) {
    const user = this.store.getUser(conn.userId);
    if (user.guest) {
      const ownedTemp = Object.values(this.store.state.servers)
        .filter((server) => server.ownerId === conn.userId).length;
      if (ownedTemp >= 1) {
        this.ack(conn, m.req, false, {}, 'Guests can host one temporary server at a time. Register a free account for unlimited permanent servers.');
        return;
      }
    }
    if ((this.userServers.get(conn.userId) || new Set()).size >= LIMITS.serversPerUser) {
      this.ack(conn, m.req, false, {}, 'You are in the maximum number of servers.');
      return;
    }
    const name = sanitizeText(m.name, LIMITS.serverName).trim();
    if (name.length < 2) {
      this.ack(conn, m.req, false, {}, 'Server names need at least 2 characters.');
      return;
    }

    const state = this.store.state;
    const server = {
      id: this.store.makeId('s'),
      name,
      icon: sanitizeText(m.icon, 4).trim() || null,
      ownerId: conn.userId,
      inviteCode: this.newInviteCode(),
      createdAt: nowMs(),
      temp: Boolean(user.guest),
      expiresAt: user.guest ? nowMs() + this.config.guestServerTtlMs : null,
      members: { [conn.userId]: { role: 'owner', joinedAt: nowMs() } },
      bans: {},
      channels: {}
    };

    const general = {
      id: this.store.makeId('ch'),
      name: 'general',
      type: 'text',
      topic: 'Talk about anything',
      position: 0,
      createdAt: nowMs(),
      lastAt: 0
    };
    const lounge = {
      id: this.store.makeId('ch'),
      name: 'Lounge',
      type: 'voice',
      topic: '',
      position: 1,
      createdAt: nowMs(),
      lastAt: 0
    };
    server.channels[general.id] = general;
    server.channels[lounge.id] = lounge;

    state.servers[server.id] = server;
    state.invites[server.inviteCode] = server.id;
    this.indexMembership(conn.userId, server.id);
    this.store.markDirty();

    const view = this.serverView(server, conn.userId);
    this.ack(conn, m.req, true, { server: view });
    this.sendToUser(conn.userId, { t: 'server-added', server: view });
  }

  newInviteCode() {
    let code;
    do {
      code = this.store.makeId().slice(-8);
    } while (this.store.state.invites[code]);
    return code;
  }

  opUpdateServer(conn, m) {
    const server = this.requireServer(conn, m.serverId);
    const role = server && this.roleOf(server, conn.userId);
    if (!server || (role !== 'owner' && role !== 'admin')) {
      this.ack(conn, m.req, false, {}, 'Only the owner or admins can change server settings.');
      return;
    }
    if (m.name !== undefined) {
      const name = sanitizeText(m.name, LIMITS.serverName).trim();
      if (name.length < 2) {
        this.ack(conn, m.req, false, {}, 'Server names need at least 2 characters.');
        return;
      }
      server.name = name;
    }
    if (m.icon !== undefined) {
      server.icon = sanitizeText(m.icon, 4).trim() || null;
    }
    this.store.markDirty();
    this.ack(conn, m.req, true);
    this.broadcastServerUpdated(server);
  }

  broadcastServerUpdated(server) {
    for (const memberId of Object.keys(server.members)) {
      this.sendToUser(memberId, { t: 'server-updated', server: this.serverView(server, memberId) });
    }
  }

  opRegenInvite(conn, m) {
    const server = this.requireServer(conn, m.serverId);
    const role = server && this.roleOf(server, conn.userId);
    if (!server || (role !== 'owner' && role !== 'admin')) {
      this.ack(conn, m.req, false, {}, 'Only the owner or admins can reset the invite link.');
      return;
    }
    delete this.store.state.invites[server.inviteCode];
    server.inviteCode = this.newInviteCode();
    this.store.state.invites[server.inviteCode] = server.id;
    this.store.markDirty();
    this.ack(conn, m.req, true, { inviteCode: server.inviteCode });
    this.broadcastServerUpdated(server);
  }

  async opDeleteServer(conn, m) {
    const server = this.requireServer(conn, m.serverId);
    if (!server || server.ownerId !== conn.userId) {
      this.ack(conn, m.req, false, {}, 'Only the owner can delete a server.');
      return;
    }
    this.ack(conn, m.req, true);
    await this.destroyServer(server, 'deleted');
  }

  /** Tears a server down completely: voice, invites, memberships, logs. */
  async destroyServer(server, reason) {
    const memberIds = Object.keys(server.members);
    const channelKeys = Object.keys(server.channels).map((channelId) => `srv:${server.id}:${channelId}`);

    for (const channelKey of channelKeys) {
      this.dropVoiceChannel(channelKey);
    }

    delete this.store.state.invites[server.inviteCode];
    delete this.store.state.servers[server.id];
    for (const memberId of memberIds) {
      this.unindexMembership(memberId, server.id);
    }
    this.store.markDirty();

    for (const memberId of memberIds) {
      this.sendToUser(memberId, { t: 'server-removed', serverId: server.id, reason, serverName: server.name });
    }

    for (const channelKey of channelKeys) {
      await this.store.removeChannelLog(channelKey);
    }
  }

  /** Temporary (guest-hosted) servers evaporate when their timer runs out. */
  sweepExpiredServers() {
    const now = nowMs();
    const expired = Object.values(this.store.state.servers)
      .filter((server) => server.temp && server.expiresAt && server.expiresAt <= now);
    for (const server of expired) {
      this.destroyServer(server, 'expired').catch((error) => {
        console.error('Could not clean up an expired temporary server:', error);
      });
    }
  }

  opLeaveServer(conn, m) {
    const server = this.requireServer(conn, m.serverId);
    if (!server) {
      this.ack(conn, m.req, false, {}, 'You are not in that server.');
      return;
    }
    if (server.ownerId === conn.userId) {
      this.ack(conn, m.req, false, {}, 'Owners cannot leave their own server. Delete it or transfer it first.');
      return;
    }
    this.removeMember(server, conn.userId, 'left');
    this.ack(conn, m.req, true);
  }

  removeMember(server, userId, reason) {
    delete server.members[userId];
    this.unindexMembership(userId, server.id);
    this.store.markDirty();

    // Pull the user's connections out of any voice channel in this server.
    for (const conn of this.userConns(userId)) {
      if (conn.voiceKey && conn.voiceKey.startsWith(`srv:${server.id}:`)) {
        this.leaveVoice(conn);
      }
    }

    this.sendToUser(userId, { t: 'server-removed', serverId: server.id, reason });
    this.broadcastToServer(server.id, { t: 'member-left', serverId: server.id, userId, reason });
  }

  opJoinInvite(conn, m) {
    const code = sanitizeText(m.code, 32).trim().toLowerCase();
    const serverId = this.store.state.invites[code];
    const server = serverId ? this.store.state.servers[serverId] : null;
    if (!server) {
      this.ack(conn, m.req, false, {}, 'That invite link is not valid.');
      return;
    }
    if (server.bans && server.bans[conn.userId]) {
      this.ack(conn, m.req, false, {}, 'You are banned from that server.');
      return;
    }
    if ((this.userServers.get(conn.userId) || new Set()).size >= LIMITS.serversPerUser) {
      this.ack(conn, m.req, false, {}, 'You are in the maximum number of servers.');
      return;
    }

    if (!server.members[conn.userId]) {
      server.members[conn.userId] = { role: 'member', joinedAt: nowMs() };
      this.indexMembership(conn.userId, server.id);
      this.store.markDirty();

      const user = this.store.getUser(conn.userId);
      this.broadcastToServer(server.id, {
        t: 'member-joined',
        serverId: server.id,
        member: { userId: conn.userId, role: 'member', joinedAt: server.members[conn.userId].joinedAt },
        user: this.publicUser(user),
        online: true
      }, null);
    }

    const view = this.serverView(server, conn.userId);
    this.ack(conn, m.req, true, { server: view, users: this.usersFor(server) });
    this.sendToUser(conn.userId, { t: 'server-added', server: view, users: this.usersFor(server) });
  }

  usersFor(server) {
    const users = {};
    for (const memberId of Object.keys(server.members)) {
      const user = this.store.getUser(memberId);
      if (user) {
        users[memberId] = { ...this.publicUser(user), online: this.connsByUser.has(memberId) };
      }
    }
    return users;
  }

  // --------------------------------------------------------------- channels

  opCreateChannel(conn, m) {
    const server = this.requireServer(conn, m.serverId);
    const role = server && this.roleOf(server, conn.userId);
    if (!server || (role !== 'owner' && role !== 'admin')) {
      this.ack(conn, m.req, false, {}, 'Only the owner or admins can create channels.');
      return;
    }
    if (Object.keys(server.channels).length >= LIMITS.channelsPerServer) {
      this.ack(conn, m.req, false, {}, 'This server has the maximum number of channels.');
      return;
    }
    const type = m.kind === 'voice' ? 'voice' : 'text';
    const name = type === 'text'
      ? normalizeChannelName(m.name)
      : sanitizeText(m.name, LIMITS.channelName).trim();
    if (!name) {
      this.ack(conn, m.req, false, {}, 'Enter a channel name.');
      return;
    }

    const channel = {
      id: this.store.makeId('ch'),
      name,
      type,
      topic: sanitizeText(m.topic, LIMITS.topic).trim(),
      position: Object.keys(server.channels).length,
      createdAt: nowMs(),
      lastAt: 0
    };
    server.channels[channel.id] = channel;
    this.store.markDirty();

    this.ack(conn, m.req, true, { channel });
    this.broadcastToServer(server.id, { t: 'channel-added', serverId: server.id, channel });
  }

  opUpdateChannel(conn, m) {
    const server = this.requireServer(conn, m.serverId);
    const role = server && this.roleOf(server, conn.userId);
    const channel = server && server.channels[m.channelId];
    if (!server || !channel || (role !== 'owner' && role !== 'admin')) {
      this.ack(conn, m.req, false, {}, 'Only the owner or admins can edit channels.');
      return;
    }
    if (m.name !== undefined) {
      const name = channel.type === 'text'
        ? normalizeChannelName(m.name)
        : sanitizeText(m.name, LIMITS.channelName).trim();
      if (!name) {
        this.ack(conn, m.req, false, {}, 'Enter a channel name.');
        return;
      }
      channel.name = name;
    }
    if (m.topic !== undefined) {
      channel.topic = sanitizeText(m.topic, LIMITS.topic).trim();
    }
    this.store.markDirty();
    this.ack(conn, m.req, true);
    this.broadcastToServer(server.id, { t: 'channel-updated', serverId: server.id, channel });
  }

  async opDeleteChannel(conn, m) {
    const server = this.requireServer(conn, m.serverId);
    const role = server && this.roleOf(server, conn.userId);
    const channel = server && server.channels[m.channelId];
    if (!server || !channel || (role !== 'owner' && role !== 'admin')) {
      this.ack(conn, m.req, false, {}, 'Only the owner or admins can delete channels.');
      return;
    }
    const textChannels = Object.values(server.channels).filter((c) => c.type === 'text');
    if (channel.type === 'text' && textChannels.length <= 1) {
      this.ack(conn, m.req, false, {}, 'A server needs at least one text channel.');
      return;
    }

    const channelKey = `srv:${server.id}:${channel.id}`;
    this.dropVoiceChannel(channelKey);
    delete server.channels[channel.id];
    this.store.markDirty();

    this.ack(conn, m.req, true);
    this.broadcastToServer(server.id, { t: 'channel-removed', serverId: server.id, channelId: channel.id });
    await this.store.removeChannelLog(channelKey);
  }

  // ------------------------------------------------------------- moderation

  opKick(conn, m) {
    const server = this.requireServer(conn, m.serverId);
    if (!server || !server.members[m.userId] || !this.canModerate(server, conn.userId, m.userId)) {
      this.ack(conn, m.req, false, {}, 'You cannot kick that member.');
      return;
    }
    this.removeMember(server, m.userId, 'kicked');
    this.ack(conn, m.req, true);
  }

  opBan(conn, m) {
    const server = this.requireServer(conn, m.serverId);
    if (!server || !server.members[m.userId] || !this.canModerate(server, conn.userId, m.userId)) {
      this.ack(conn, m.req, false, {}, 'You cannot ban that member.');
      return;
    }
    server.bans = server.bans || {};
    server.bans[m.userId] = { by: conn.userId, at: nowMs() };
    this.removeMember(server, m.userId, 'banned');
    this.store.markDirty();
    this.ack(conn, m.req, true);
    this.broadcastServerUpdated(server);
  }

  opUnban(conn, m) {
    const server = this.requireServer(conn, m.serverId);
    const role = server && this.roleOf(server, conn.userId);
    if (!server || (role !== 'owner' && role !== 'admin')) {
      this.ack(conn, m.req, false, {}, 'Only the owner or admins can lift bans.');
      return;
    }
    if (server.bans && server.bans[m.userId]) {
      delete server.bans[m.userId];
      this.store.markDirty();
    }
    this.ack(conn, m.req, true);
    this.broadcastServerUpdated(server);
  }

  opSetRole(conn, m) {
    const server = this.requireServer(conn, m.serverId);
    if (!server || server.ownerId !== conn.userId) {
      this.ack(conn, m.req, false, {}, 'Only the owner can change roles.');
      return;
    }
    const member = server.members[m.userId];
    const role = m.role === 'admin' ? 'admin' : 'member';
    if (!member || m.userId === conn.userId) {
      this.ack(conn, m.req, false, {}, 'You cannot change that role.');
      return;
    }
    member.role = role;
    this.store.markDirty();
    this.ack(conn, m.req, true);
    this.broadcastToServer(server.id, { t: 'member-updated', serverId: server.id, userId: m.userId, role });
  }

  // --------------------------------------------------------------- messages

  /** Membership check for any channel key ("srv:<server>:<channel>" or "dm:<id>"). */
  resolveChannel(conn, channelKey) {
    if (typeof channelKey !== 'string' || channelKey.length > 120) {
      return null;
    }
    if (channelKey.startsWith('srv:')) {
      const [, serverId, channelId] = channelKey.split(':');
      const server = this.requireServer(conn, serverId);
      const channel = server && server.channels[channelId];
      if (!server || !channel) {
        return null;
      }
      return { kind: 'server', server, channel, channelKey };
    }
    if (channelKey.startsWith('dm:')) {
      const dm = this.store.state.dms[channelKey.slice(3)];
      if (!dm || !dm.users.includes(conn.userId)) {
        return null;
      }
      return { kind: 'dm', dm, channelKey };
    }
    return null;
  }

  opMessages(conn, m) {
    const target = this.resolveChannel(conn, m.channelKey);
    if (!target || (target.channel && target.channel.type !== 'text')) {
      this.ack(conn, m.req, false, {}, 'You cannot read that channel.');
      return;
    }
    const beforeId = typeof m.beforeId === 'string' ? m.beforeId.slice(0, 40) : null;
    const { messages, hasMore } = this.store.getMessages(m.channelKey, {
      beforeId,
      limit: LIMITS.messageHistoryPage
    });

    const users = {};
    for (const message of messages) {
      if (!users[message.authorId]) {
        const author = this.store.getUser(message.authorId);
        if (author) {
          users[message.authorId] = this.publicUser(author);
        }
      }
    }
    this.ack(conn, m.req, true, { channelKey: m.channelKey, messages, hasMore, users });
  }

  opSend(conn, m) {
    const target = this.resolveChannel(conn, m.channelKey);
    if (!target || (target.channel && target.channel.type !== 'text')) {
      this.ack(conn, m.req, false, {}, 'You cannot post in that channel.');
      return;
    }

    const content = sanitizeText(m.content, LIMITS.content).replace(/\s+$/g, '');
    const attachments = this.cleanAttachments(m.attachments);
    if (!content.trim() && !attachments.length) {
      this.ack(conn, m.req, false, {}, 'Messages need text or an attachment.');
      return;
    }

    const message = {
      id: this.store.makeId(),
      authorId: conn.userId,
      content,
      createdAt: nowMs(),
      reactions: {},
      attachments,
      replyTo: typeof m.replyTo === 'string' ? m.replyTo.slice(0, 40) : null,
      mentions: extractMentions(content)
    };

    this.store.appendMessage(m.channelKey, message);
    this.touchChannel(target, message.createdAt);

    // Sending implies reading: keep the author's own unread state current.
    const author = this.store.getUser(conn.userId);
    author.lastRead[m.channelKey] = message.createdAt;
    this.store.markDirty();

    this.ack(conn, m.req, true, { message, nonce: m.nonce, channelKey: m.channelKey });
    this.broadcastToChannel(m.channelKey, {
      t: 'message',
      channelKey: m.channelKey,
      message,
      user: this.publicUser(author)
    }, conn);
  }

  cleanAttachments(list) {
    if (!Array.isArray(list)) {
      return [];
    }
    const cleaned = [];
    for (const item of list.slice(0, LIMITS.attachmentsPerMessage)) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const url = String(item.url || '');
      if (!/^\/uploads\/[a-zA-Z0-9_.-]+$/.test(url)) {
        continue;
      }
      cleaned.push({
        url,
        name: sanitizeText(item.name, 120) || 'file',
        size: Math.max(0, Number(item.size) || 0),
        type: sanitizeText(item.type, 80)
      });
    }
    return cleaned;
  }

  touchChannel(target, ts) {
    if (target.kind === 'server') {
      target.channel.lastAt = ts;
    } else {
      target.dm.lastAt = ts;
    }
    this.store.markDirty();
  }

  opEdit(conn, m) {
    const target = this.resolveChannel(conn, m.channelKey);
    const message = target && this.store.getMessage(m.channelKey, String(m.messageId || ''));
    if (!message || message.deleted || message.authorId !== conn.userId) {
      this.ack(conn, m.req, false, {}, 'You can only edit your own messages.');
      return;
    }
    const content = sanitizeText(m.content, LIMITS.content).trim();
    if (!content && !(message.attachments || []).length) {
      this.ack(conn, m.req, false, {}, 'Messages need text or an attachment.');
      return;
    }
    const updated = this.store.editMessage(m.channelKey, message.id, content, nowMs());
    updated.mentions = extractMentions(content);
    this.ack(conn, m.req, true);
    this.broadcastToChannel(m.channelKey, { t: 'message-updated', channelKey: m.channelKey, message: updated });
  }

  opDeleteMessage(conn, m) {
    const target = this.resolveChannel(conn, m.channelKey);
    const message = target && this.store.getMessage(m.channelKey, String(m.messageId || ''));
    if (!message || message.deleted) {
      this.ack(conn, m.req, false, {}, 'That message is gone.');
      return;
    }

    let allowed = message.authorId === conn.userId;
    if (!allowed && target.kind === 'server') {
      const role = this.roleOf(target.server, conn.userId);
      allowed = role === 'owner' || role === 'admin';
    }
    if (!allowed) {
      this.ack(conn, m.req, false, {}, 'You cannot delete that message.');
      return;
    }

    const updated = this.store.deleteMessage(m.channelKey, message.id);
    this.ack(conn, m.req, true);
    this.broadcastToChannel(m.channelKey, { t: 'message-updated', channelKey: m.channelKey, message: updated });
  }

  opReact(conn, m) {
    const target = this.resolveChannel(conn, m.channelKey);
    const message = target && this.store.getMessage(m.channelKey, String(m.messageId || ''));
    const emoji = sanitizeText(m.emoji, LIMITS.emoji).trim();
    if (!message || message.deleted || !emoji) {
      this.ack(conn, m.req, false, {}, 'You cannot react to that message.');
      return;
    }
    const existing = new Set((message.reactions || {})[emoji] || []);
    const on = m.on === undefined ? !existing.has(conn.userId) : Boolean(m.on);
    if (Object.keys(message.reactions || {}).length >= 20 && on && !message.reactions[emoji]) {
      this.ack(conn, m.req, false, {}, 'That message has enough reactions already.');
      return;
    }
    const updated = this.store.setReaction(m.channelKey, message.id, emoji, conn.userId, on);
    this.ack(conn, m.req, true);
    this.broadcastToChannel(m.channelKey, { t: 'message-updated', channelKey: m.channelKey, message: updated });
  }

  opTyping(conn, m) {
    const target = this.resolveChannel(conn, m.channelKey);
    if (!target) {
      return;
    }
    const last = conn.typing.get(m.channelKey) || 0;
    if (nowMs() - last < 2000) {
      return;
    }
    conn.typing.set(m.channelKey, nowMs());
    this.broadcastToChannel(m.channelKey, { t: 'typing', channelKey: m.channelKey, userId: conn.userId }, conn);
  }

  opRead(conn, m) {
    const target = this.resolveChannel(conn, m.channelKey);
    if (!target) {
      return;
    }
    const user = this.store.getUser(conn.userId);
    const ts = Math.min(Number(m.ts) || nowMs(), nowMs());
    if ((user.lastRead[m.channelKey] || 0) < ts) {
      user.lastRead[m.channelKey] = ts;
      this.store.markDirty();
      this.sendToUser(conn.userId, { t: 'read', channelKey: m.channelKey, ts });
    }
    this.ack(conn, m.req, true);
  }

  // --------------------------------------------------------------------- dm

  opFindUser(conn, m) {
    const user = this.store.getUserByUsername(sanitizeText(m.username, 24));
    if (!user || user.id === conn.userId) {
      this.ack(conn, m.req, false, {}, 'No user with that username was found.');
      return;
    }
    this.ack(conn, m.req, true, {
      user: { ...this.publicUser(user), online: this.connsByUser.has(user.id) }
    });
  }

  opDmOpen(conn, m) {
    const other = this.store.getUser(String(m.userId || ''));
    if (!other || other.id === conn.userId) {
      this.ack(conn, m.req, false, {}, 'That user was not found.');
      return;
    }

    let dm = Object.values(this.store.state.dms).find(
      (thread) => thread.users.includes(conn.userId) && thread.users.includes(other.id)
    );
    let created = false;
    if (!dm) {
      dm = {
        id: this.store.makeId('d'),
        users: [conn.userId, other.id],
        createdAt: nowMs(),
        lastAt: 0
      };
      this.store.state.dms[dm.id] = dm;
      this.store.markDirty();
      created = true;
    }

    const me = this.store.getUser(conn.userId);
    this.ack(conn, m.req, true, {
      dm: this.dmView(dm, conn.userId),
      user: { ...this.publicUser(other), online: this.connsByUser.has(other.id) }
    });
    if (created) {
      this.sendToUser(conn.userId, {
        t: 'dm-added',
        dm: this.dmView(dm, conn.userId),
        user: { ...this.publicUser(other), online: this.connsByUser.has(other.id) }
      });
      this.sendToUser(other.id, {
        t: 'dm-added',
        dm: this.dmView(dm, other.id),
        user: { ...this.publicUser(me), online: true }
      });
    }
  }

  opProfile(conn, m) {
    const user = this.store.getUser(conn.userId);
    if (m.displayName !== undefined) {
      const name = sanitizeText(m.displayName, 40).replace(/\s+/g, ' ').trim();
      if (name.length < 2) {
        this.ack(conn, m.req, false, {}, 'Display names need at least 2 characters.');
        return;
      }
      user.displayName = name;
    }
    if (m.color !== undefined) {
      const color = Number(m.color);
      if (Number.isInteger(color) && color >= 1 && color <= 8) {
        user.color = color;
      }
    }
    this.store.markDirty();
    this.ack(conn, m.req, true, { user: this.publicUser(user) });
    this.broadcastUserUpdated(user.id);
  }

  // ------------------------------------------------------------------ voice

  voiceChannelServerId(channelKey) {
    return channelKey.startsWith('srv:') ? channelKey.split(':')[1] : null;
  }

  broadcastVoiceState(channelKey) {
    const participants = Array.from((this.voice.get(channelKey) || new Map()).values());
    const serverId = this.voiceChannelServerId(channelKey);
    const message = { t: 'voice-state', channelKey, participants };
    if (serverId) {
      this.broadcastToServer(serverId, message);
    }
  }

  opVoiceJoin(conn, m) {
    const target = this.resolveChannel(conn, m.channelKey);
    if (!target || target.kind !== 'server' || target.channel.type !== 'voice') {
      this.ack(conn, m.req, false, {}, 'That is not a voice channel you can join.');
      return;
    }

    if (conn.voiceKey === m.channelKey) {
      this.ack(conn, m.req, true, { participants: Array.from(this.voice.get(m.channelKey).values()) });
      return;
    }

    let participants = this.voice.get(m.channelKey);
    if (participants && participants.size >= this.config.maxVoicePeers) {
      this.ack(conn, m.req, false, {}, `This voice channel is full (${this.config.maxVoicePeers} people).`);
      return;
    }

    this.leaveVoice(conn); // moving between channels

    if (!participants) {
      participants = new Map();
      this.voice.set(m.channelKey, participants);
    }

    const participant = {
      connId: conn.id,
      userId: conn.userId,
      media: {
        audio: Boolean(m.media && m.media.audio),
        video: Boolean(m.media && m.media.video),
        screen: false
      },
      joinedAt: nowMs()
    };
    participants.set(conn.id, participant);
    conn.voiceKey = m.channelKey;

    this.ack(conn, m.req, true, {
      channelKey: m.channelKey,
      participants: Array.from(participants.values())
    });
    this.broadcastVoiceState(m.channelKey);
  }

  leaveVoice(conn) {
    if (!conn.voiceKey) {
      return;
    }
    const channelKey = conn.voiceKey;
    conn.voiceKey = null;
    const participants = this.voice.get(channelKey);
    if (participants) {
      participants.delete(conn.id);
      if (!participants.size) {
        this.voice.delete(channelKey);
      }
    }
    this.broadcastVoiceState(channelKey);
  }

  dropVoiceChannel(channelKey) {
    const participants = this.voice.get(channelKey);
    if (!participants) {
      return;
    }
    for (const participant of participants.values()) {
      const conn = this.conns.get(participant.connId);
      if (conn) {
        conn.voiceKey = null;
        this.send(conn, { t: 'voice-kicked', channelKey });
      }
    }
    this.voice.delete(channelKey);
    this.broadcastVoiceState(channelKey);
  }

  opVoiceMedia(conn, m) {
    if (!conn.voiceKey) {
      return;
    }
    const participants = this.voice.get(conn.voiceKey);
    const participant = participants && participants.get(conn.id);
    if (!participant) {
      return;
    }
    participant.media = {
      audio: Boolean(m.media && m.media.audio),
      video: Boolean(m.media && m.media.video),
      screen: Boolean(m.media && m.media.screen)
    };
    this.broadcastVoiceState(conn.voiceKey);
  }

  opSignal(conn, m) {
    if (!conn.voiceKey || typeof m.target !== 'string') {
      return;
    }
    const participants = this.voice.get(conn.voiceKey);
    const targetConn = this.conns.get(m.target);
    if (!participants || !participants.has(m.target) || !targetConn) {
      return;
    }
    const payload = m.payload;
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const hasDescription = payload.description &&
      (payload.description.type === 'offer' || payload.description.type === 'answer') &&
      typeof payload.description.sdp === 'string';
    const hasCandidate = payload.candidate && typeof payload.candidate.candidate === 'string';
    const hasMeta = payload.meta && typeof payload.meta === 'object';
    if (!hasDescription && !hasCandidate && !hasMeta) {
      return;
    }

    this.send(targetConn, {
      t: 'signal',
      from: conn.id,
      fromUserId: conn.userId,
      payload
    });
  }

  close() {
    clearInterval(this.heartbeat);
    clearInterval(this.sweeper);
    for (const conn of this.conns.values()) {
      conn.ws.close(1001, 'Server shutting down');
    }
    this.wss.close();
  }
}

module.exports = { Hub, LIMITS };
