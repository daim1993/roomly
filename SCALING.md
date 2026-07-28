# Scaling Roomly to 1,000,000 users

Roomly ships as a single Node process because that is the correct starting
point: zero ops burden, and one modern server comfortably handles thousands of
concurrent users. But "Discord-like at Discord scale" is an architecture, not a
single feature, so this document lays out the honest, staged path — including
exactly which seams in this codebase are designed to be replaced at each stage.

The two seams that matter:

- **`lib/store.js`** — all persistence goes through one class with a small API
  (`appendMessage`, `getMessages`, `createUser`, …). Nothing else touches disk.
- **`lib/hub.js`** — all fan-out goes through `sendToUser` / `broadcastToServer`
  / `broadcastToChannel`. Nothing else touches sockets.

Swap those two and the product code above them does not change.

---

## Stage 0 — what you have now (1 → ~5,000 concurrent)

```
Browser ⇄ HTTPS/WSS ⇄ Node (static + REST + WS hub) ⇄ disk (JSON + JSONL)
                     WebRTC mesh (P2P) for voice, STUN/TURN assisted
```

- Messages: append-only JSONL per channel; bounded in-memory window per
  channel; atomic debounced state snapshots. Crash-safe (torn last lines are
  tolerated on replay).
- Voice: full mesh, capped at `MAX_VOICE_PEERS` (12). Each participant uploads
  N−1 copies of their media — the cap is physics (upload bandwidth), not code.
- Ops checklist at this stage: HTTPS termination, `TRUST_PROXY=1`, a TURN
  server (coturn), disk backups of `data/`, `node --max-old-space-size` sized
  to the box.

## Stage 1 — durable core (5k → ~50k concurrent, one region)

1. **Postgres replaces the JSON store.** Tables: `users`, `sessions`,
   `servers`, `members`, `channels`, `messages (channel_key, id, …)` with a
   B-tree on `(channel_key, id)` — the sortable message ids in `store.js` were
   chosen so this migration is a straight copy. Message pages become
   `SELECT … WHERE channel_key = $1 AND id < $2 ORDER BY id DESC LIMIT 60`.
2. **Object storage for uploads** (S3/R2/MinIO) with signed URLs, replacing
   `data/uploads`.
3. **Redis for hot state**: sessions, presence, voice-channel occupancy,
   rate-limit counters — everything in `hub.js` that is currently an in-memory
   `Map`.
4. Run 2–3 Node replicas behind a load balancer for availability; WS
   connections are sticky by default (one long-lived TCP per client).

## Stage 2 — horizontal realtime (50k → ~500k concurrent)

The single-process assumption to break is *"every recipient is connected to
this process."*

1. **Redis pub/sub (or NATS) between WS nodes.** `broadcastToServer(serverId,
   message)` becomes `PUBLISH guild:{serverId}`; every WS node subscribes to
   the guilds its connected users belong to and relays to local sockets. This
   is a ~100-line change confined to `hub.js`'s three fan-out helpers.
2. **Stateless WS nodes.** All authority (membership checks, rate limits,
   voice occupancy) reads Redis/Postgres, so any node can serve any user and
   deploys are rolling.
3. **Backpressure:** per-socket send queues with drop-oldest for presence and
   typing (they are refreshable), never for messages.
4. **Fan-out shaping:** presence updates and typing indicators become
   channel-scoped subscriptions rather than server-wide broadcasts; member
   lists page lazily above ~1k members (Discord does exactly this).

## Stage 3 — voice at scale (SFU)

Mesh cannot exceed ~a dozen people; the fix is an SFU (each client uploads
once, the server forwards). Two proven paths:

- **LiveKit / mediasoup / Janus** cluster. The client's `js/rtc.js` keeps its
  UI contract (tiles, streams, speaking) but connects to the SFU instead of N
  peers; the hub's `voice-join` handler returns an SFU room token instead of a
  participant list to offer.
- Voice servers are **regional** (latency) and **stateless per room**, so
  rooms hash-shard across the fleet. TURN becomes a fleet, too.

With an SFU, voice channels comfortably hold 50–200+ participants and
screen-share streams become simulcast layers (quality adapts per viewer).

## Stage 4 — 1M users

At this point you are running Discord's actual shape:

- **Guild sharding:** a guild (server) lives on a "guild process" shard
  (consistent-hash by guild id) that owns its hot state; WS edge nodes route
  events to shards. Rebalancing = moving guild actors, not users.
- **Postgres partitioning** of `messages` by `(channel_key, time)` +
  read replicas; or move messages to Cassandra/Scylla (Discord's route) once
  write volume demands it.
- **Edge:** static assets on a CDN, WS edge PoPs per region, uploads served
  from object storage directly.
- **Observability:** per-op latency histograms on the hub (the `op` routing in
  `hub.js` is the single choke point to instrument), Redis/PG saturation
  alerts, socket-count autoscaling.

### Honest capacity math

1M *registered* users ≈ 50–100k *concurrent* (Discord's public ratios).
That is: ~10–20 WS edge nodes (5k conns each, comfortable), a 3-node Redis
cluster, one beefy Postgres primary + replicas or a partitioned cluster, and
an SFU/TURN fleet sized to concurrent voice minutes. All of it reachable from
this codebase by replacing the two seams — the client protocol (`ready`
snapshot + small JSON events + WebRTC signaling relay) does not need to
change shape at any stage.

## What was deliberately kept simple here

- JSONL logs cap the in-memory window at 600 messages/channel (full history
  stays on disk; "load older" pages within the window). Postgres removes the
  cap.
- Rate limits are per-connection token buckets; Stage 1 moves them to Redis so
  they are per-user across nodes.
- Invites are single static codes per server; expiring/limited-use invites are
  a `store.js` schema addition.
