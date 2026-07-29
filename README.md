# Roomly

Roomly is a self-hosted, Discord-style communication platform that runs entirely in the browser: build **servers**, open **text and voice channels**, drop into rooms with **camera and screen share**, chat with **history, reactions, replies, mentions and file uploads**, message people directly, and moderate with **owner/admin roles, kicks and bans** — with accounts or one-click guest access.

One Node.js process. One dependency (`ws`). No build step.

## Features

**Community structure** — unlimited servers with emoji icons, text channels (topics, rename, delete), voice channels, shareable invite links (`/invite/<code>`) that work for both account holders and guests, invite reset for admins.

**Text chat** — persistent history with lazy paging ("load older"), markdown-lite (`**bold**`, `*italic*`, `` `code` ``, ``` blocks, ~~strike~~, links), @mentions with autocomplete, replies, edits, deletes, emoji reactions, typing indicators, unread + mention badges everywhere. Attachments render inline: **images and GIFs**, **video players**, and **voice messages** you record right in the composer (hold-to-talk mic button). Drag-drop, paste, and image lightbox included. Voice channels have their own text chat too (toggle the # button in the call).

**Voice & video rooms** — multi-party WebRTC mesh calls inside voice channels, camera on/off, mute, **screen sharing** with a focused stage layout, **click-to-pin** anyone full-screen (Meet-style), speaking rings, live occupancy in the sidebar, a call timer, voice that stays connected while you browse (dock control bar), join/leave chimes, and **lock-screen keep-alive** on mobile (Wake Lock + Media Session) so calls survive the screen turning off.

**Worldwide call efficiency** — the mesh engine is tuned for long-haul links: pre-gathered ICE with one bundled transport (calls connect fast), two independent anycast STUN providers, **Opus DTX + in-band FEC** at a 40 kbps cap so voice stays crisp through packet loss, audio prioritized above video, **VP9 in small rooms / VP8 in large ones**, and a per-room **bandwidth budget** that automatically steps camera bitrate, resolution and framerate down as more people join (1.5 Mbps 1:1 → 260 kbps in a full room). Screen shares keep text sharp (maintain-resolution), cameras keep motion fluid (maintain-framerate). Add a TURN server via `TURN_URL` for strict corporate/mobile networks — for true worldwide scale, front an SFU as described in SCALING.md.

**Self-healing connections** — every link runs a bounded recovery ladder instead of hanging on "Connecting": clients fetch fresh short-lived TURN credentials right before each call, a 12-second watchdog fires ICE restarts (up to 3), then rebuilds the peer connection from scratch, then rebuilds once more in **relay-only mode** (forces TURN over TCP/TLS 443 — the path that passes VPNs, symmetric NATs and UDP-blocked firewalls), and only then shows "Connection failed" with a **Retry** button that renegotiates with fresh credentials — no page reload. Wi-Fi→mobile handoffs and VPN toggles mid-call trigger an immediate reconnect, 30 seconds of stable link earns the full recovery budget back, and every successful connection logs its real path (`host/srflx/relay × udp/tcp/tls`) to the console via `getStats()` so stuck environments leave evidence.

**People** — accounts (username + password, scrypt-hashed) or guest mode, presence (online/offline), member list grouped by status with role icons, direct messages (find by username or click any member). Full profiles: **image avatars** (PNG/JPG upload, click your avatar to change it), display names (your @username never changes), **pronouns**, a 190-character **About Me** with markdown and emoji, **custom statuses** with an emoji and a timer (1 hour / 24 hours / until cleared), and **profile privacy** (everyone / small servers ≤200 + DMs / DM contacts only — avatar, name and username always stay visible).

**Moderation** — server owner + admins, promote/demote, kick, ban/unban, delete anyone's message (admins), channel management. Guests get one auto-expiring temporary server.

**Admin console** — a separate `/admin` dashboard for platform admins: live instance stats (accounts, online, in-voice, messages, storage), account management (disable/enable, reset password, promote/demote admins, delete), and server management (delete any server). The first registered account becomes the platform admin; grant more with `ADMIN_USERS` or from the console.

**Storage** — durable **SQLite** database (`data/roomly.db`, WAL mode) via Node's built-in `node:sqlite`, with automatic one-time migration from the older JSON/JSONL files. Falls back to the JSON file store automatically on Node versions without `node:sqlite`.

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
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | — | Your own TURN relay (comma-separate multiple URLs) — highest priority |
| `TURN_REST_API` | — | TURN REST credentials endpoint (e.g. a free [Metered](https://www.metered.ca/tools/openrelay/) account: `https://<app>.metered.live/api/v1/turn/credentials?apiKey=KEY`) — refreshed every 4h |
| `TURN_DISABLE` | off (`1` to disable) | Turn off the built-in Open Relay community TURN fallback |
| `ADMIN_USERS` | — | Comma-separated usernames granted platform-admin on boot |
| `GUEST_SERVER_TTL_HOURS` | `24` | Lifetime of guest-created temporary servers |
| `ROOMLY_DB` | (auto) | Set to `files` to force the JSON store instead of SQLite |
| `TRUST_PROXY` | off (`1` to enable) | Honor `X-Forwarded-*` behind a reverse proxy; also marks session cookies `Secure` on HTTPS |

## Production notes

- **Use HTTPS.** Browsers only allow camera/microphone/screen capture on HTTPS or `localhost`. Put Roomly behind Caddy, nginx or Traefik and proxy WebSockets on `/ws` (set `TRUST_PROXY=1`).
- **TURN is built in.** With no configuration, the server mints short-lived credentials for the Open Relay community TURN, so calls connect even through VPNs, symmetric NATs and corporate firewalls (media relays over TCP/TLS 443 when direct P2P fails). Community capacity is best-effort — for guaranteed relay, create a free [Metered](https://www.metered.ca/tools/openrelay/) account and set `TURN_REST_API`, or run your own coturn and set `TURN_URL`.
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
lib/store.js     Persistence API (SQLite or JSON files)
lib/db.js        SQLite backend (node:sqlite) + JSONL migration
admin.html       Admin console (/admin) — platform-admin dashboard
lib/auth.js      Accounts, guests, sessions (scrypt + tokens)
lib/hub.js       Realtime hub: rooms, chat, presence, voice, signaling
index.html       App shell (auth, rail, sidebar, chat, voice, modals)
styles.css       The whole look
app.js + js/     Client: state, rendering, composer, WebRTC engine
```
