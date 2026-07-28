# Roomly

Roomly is a self-hosted, Discord-style communication platform that runs entirely in the browser: build **servers**, open **text and voice channels**, drop into rooms with **camera and screen share**, chat with **history, reactions, replies, mentions and file uploads**, message people directly, and moderate with **owner/admin roles, kicks and bans** — with accounts or one-click guest access.

One Node.js process. One dependency (`ws`). No build step.

## Features

**Community structure** — unlimited servers with emoji icons, text channels (topics, rename, delete), voice channels, shareable invite links (`/invite/<code>`) that work for both account holders and guests, invite reset for admins.

**Text chat** — persistent history with lazy paging ("load older"), markdown-lite (`**bold**`, `*italic*`, `` `code` ``, ``` blocks, ~~strike~~, links), @mentions with autocomplete, replies, edits, deletes, emoji reactions, typing indicators, unread + mention badges everywhere (channel list, server rail, tab title), image/file attachments with drag-drop and paste, image lightbox.

**Voice & video rooms** — multi-party WebRTC mesh calls inside voice channels, camera on/off, mute, **screen sharing** with a focused stage layout, speaking rings, live occupancy shown in the sidebar for everyone, voice stays connected while you browse text channels (dock in the sidebar), join/leave chimes.

**People** — accounts (username + password, scrypt-hashed) or guest mode, display names and avatar colors, presence (online/offline), member list grouped by status with role icons, direct messages (find by username or click any member).

**Moderation** — server owner + admins, promote/demote, kick, ban/unban, delete anyone's message (admins), channel management permissions, "guests can't create servers" guard.

## Run it

```sh
npm install
npm start          # or double-click start-server.bat on Windows
```

Open `http://localhost:3000`, create an account (or continue as guest), build a server, and share the invite link.

For quick testing, open the invite link in a second browser or an incognito window.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where the server listens |
| `DATA_DIR` | `./data` | Durable storage (users, servers, messages, uploads) |
| `MAX_VOICE_PEERS` | `12` | People per voice channel (mesh topology — see SCALING.md) |
| `MAX_UPLOAD_MB` | `10` | Attachment size cap |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | — | TURN relay for restrictive networks (comma-separate multiple URLs) |
| `TRUST_PROXY` | off (`1` to enable) | Honor `X-Forwarded-*` behind a reverse proxy; also marks session cookies `Secure` on HTTPS |

## Production notes

- **Use HTTPS.** Browsers only allow camera/microphone/screen capture on HTTPS or `localhost`. Put Roomly behind Caddy, nginx or Traefik and proxy WebSockets on `/ws` (set `TRUST_PROXY=1`).
- **Add TURN** (e.g. coturn) for reliable calls across strict NATs and corporate networks.
- **Back up `data/`.** It contains everything: `state.json`, per-channel message logs, uploads.
- Voice channels use direct peer-to-peer mesh — great quality up to ~8–12 people. For bigger stages, front an SFU (see below).

## Docker

```sh
docker build -t roomly .
docker run -p 3000:3000 -v roomly-data:/app/data roomly
```

## Scaling

`SCALING.md` documents the staged path from this single node to a 1M-user deployment — Postgres + Redis pub/sub, stateless WS fan-out nodes, SFU-based voice, TURN fleets and guild sharding — and which seams in this codebase (`lib/store.js`, `lib/hub.js`) are designed to be swapped at each stage.

## Project layout

```
server.js        HTTP entry: static, auth API, uploads, WS upgrade
lib/store.js     Persistence: JSON snapshot + per-channel JSONL logs
lib/auth.js      Accounts, guests, sessions (scrypt + tokens)
lib/hub.js       Realtime hub: rooms, chat, presence, voice, signaling
index.html       App shell (auth, rail, sidebar, chat, voice, modals)
styles.css       The whole look
app.js + js/     Client: state, rendering, composer, WebRTC engine
```
