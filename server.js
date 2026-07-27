'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocket, WebSocketServer } = require('ws');

const host = process.env.HOST || '0.0.0.0';
const port = Number.parseInt(process.env.PORT || '3000', 10);
const maxRoomSize = Number.parseInt(process.env.MAX_ROOM_SIZE || '12', 10);

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
]);

const rooms = new Map();

function buildIceServers() {
  const iceServers = [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302'
      ]
    }
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

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (requestUrl.pathname === '/health') {
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    response.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
    return;
  }

  if (requestUrl.pathname === '/config') {
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    response.end(JSON.stringify({ iceServers: buildIceServers() }));
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method not allowed');
    return;
  }

  const asset = staticFiles.get(requestUrl.pathname);
  if (!asset) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  fs.readFile(path.join(__dirname, asset[0]), (error, content) => {
    if (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Unable to load the application');
      return;
    }

    response.writeHead(200, {
      'Content-Type': asset[1],
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'Permissions-Policy': 'camera=(self), microphone=(self)',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff'
    });

    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    response.end(content);
  });
});

const webSocketServer = new WebSocketServer({
  server,
  path: '/signal',
  maxPayload: 64 * 1024
});

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcast(room, message, excludedSocket = null) {
  const serialized = JSON.stringify(message);

  for (const socket of room.values()) {
    if (socket !== excludedSocket && socket.readyState === WebSocket.OPEN) {
      socket.send(serialized);
    }
  }
}

function publicParticipant(socket) {
  return {
    id: socket.participant.id,
    name: socket.participant.name,
    media: { ...socket.participant.media }
  };
}

function removeFromRoom(socket) {
  if (!socket.roomId || !socket.participant) {
    return;
  }

  const room = rooms.get(socket.roomId);
  if (!room || !room.delete(socket.participant.id)) {
    return;
  }

  broadcast(room, {
    type: 'peer-left',
    id: socket.participant.id
  });

  if (room.size === 0) {
    rooms.delete(socket.roomId);
  }

  socket.roomId = null;
  socket.participant = null;
}

function validRoomId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{2,47}$/.test(value);
}

function handleJoin(socket, message) {
  if (socket.roomId) {
    send(socket, { type: 'error', code: 'already-joined', message: 'You are already in a room.' });
    return;
  }

  const roomId = typeof message.roomId === 'string' ? message.roomId.trim().toLowerCase() : '';
  const name = typeof message.name === 'string' ? message.name.trim().slice(0, 40) : '';

  if (!validRoomId(roomId) || !name) {
    send(socket, { type: 'error', code: 'invalid-details', message: 'Enter a name and a valid room code.' });
    return;
  }

  let room = rooms.get(roomId);
  if (!room) {
    room = new Map();
    rooms.set(roomId, room);
  }

  if (room.size >= maxRoomSize) {
    send(socket, {
      type: 'error',
      code: 'room-full',
      message: `This room is full (${maxRoomSize} people maximum).`
    });
    return;
  }

  socket.roomId = roomId;
  socket.participant = {
    id: crypto.randomUUID(),
    name,
    media: {
      audio: Boolean(message.media && message.media.audio),
      video: Boolean(message.media && message.media.video)
    }
  };

  const existingPeers = Array.from(room.values(), publicParticipant);
  room.set(socket.participant.id, socket);

  send(socket, {
    type: 'welcome',
    id: socket.participant.id,
    roomId,
    peers: existingPeers
  });

  broadcast(room, {
    type: 'peer-joined',
    peer: publicParticipant(socket)
  }, socket);
}

function handleSignal(socket, message) {
  if (!socket.roomId || !socket.participant || typeof message.target !== 'string') {
    return;
  }

  const room = rooms.get(socket.roomId);
  const target = room && room.get(message.target);
  const payload = message.payload;

  if (!target || !payload || typeof payload !== 'object') {
    return;
  }

  const hasDescription = payload.description &&
    (payload.description.type === 'offer' || payload.description.type === 'answer') &&
    typeof payload.description.sdp === 'string';
  const hasCandidate = payload.candidate && typeof payload.candidate.candidate === 'string';

  if (!hasDescription && !hasCandidate) {
    return;
  }

  send(target, {
    type: 'signal',
    from: socket.participant.id,
    payload
  });
}

function handleMediaState(socket, message) {
  if (!socket.roomId || !socket.participant) {
    return;
  }

  socket.participant.media = {
    audio: Boolean(message.media && message.media.audio),
    video: Boolean(message.media && message.media.video)
  };

  const room = rooms.get(socket.roomId);
  if (room) {
    broadcast(room, {
      type: 'media-state',
      id: socket.participant.id,
      media: { ...socket.participant.media }
    }, socket);
  }
}

webSocketServer.on('connection', (socket) => {
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (rawMessage) => {
    let message;

    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      send(socket, { type: 'error', code: 'invalid-message', message: 'Invalid signaling message.' });
      return;
    }

    if (!message || typeof message.type !== 'string') {
      return;
    }

    if (message.type === 'join') {
      handleJoin(socket, message);
    } else if (message.type === 'signal') {
      handleSignal(socket, message);
    } else if (message.type === 'media-state') {
      handleMediaState(socket, message);
    } else if (message.type === 'leave') {
      removeFromRoom(socket);
    }
  });

  socket.on('close', () => removeFromRoom(socket));
  socket.on('error', () => removeFromRoom(socket));
});

const heartbeat = setInterval(() => {
  for (const socket of webSocketServer.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }

    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);

heartbeat.unref();

server.listen(port, host, () => {
  console.log(`Roomly is running at http://localhost:${port}`);
});

function shutdown() {
  clearInterval(heartbeat);
  webSocketServer.close();
  server.close();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
