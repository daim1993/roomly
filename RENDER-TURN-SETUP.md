# Make calls connect from ANY network (TURN setup)

Calls between people on VPNs, mobile data (CGNAT), or strict office/uni
firewalls can only connect through a TURN relay. The free community relay
(Open Relay) that Roomly used **is dead** — that is why calls said
"Connecting" forever on Render even though everything worked on localhost.

Roomly now ships with a zero-config stopgap (it borrows the public
Cloudflare speed-test relay), so calls relay again with no setup. But that
is best-effort and can break at any time. Claim your own free relay — it
takes about 5 minutes.

## Check what your deploy is using (do this first)

Open:

    https://YOUR-APP.onrender.com/api/ice

- `"turn": true, "source": "stopgap"`   → relays work via the stopgap. OK, but do Option A.
- `"turn": true, "source": "cloudflare"`→ perfect, you are done.
- `"turn": false`                       → no relay at all: finish Option A now.

## Option A — Cloudflare Realtime TURN (free 1 TB/month, recommended)

1. Sign up / log in at https://dash.cloudflare.com (free plan is fine).
2. In the left sidebar pick **Realtime** → **TURN Server** → **Create**.
3. Cloudflare shows you a **Key ID** (also called TURN Token ID) and an
   **API Token**. Copy both.
4. In the Render dashboard → your Roomly service → **Environment** → add:

       TURN_CF_KEY_ID     = <the Key ID>
       TURN_CF_API_TOKEN  = <the API Token>

5. Save → Render redeploys. Open `/api/ice` again: you should see
   `"source": "cloudflare"` and `turn.cloudflare.com` in the URLs.

The server fetches fresh short-lived credentials from your key every 20
minutes and hands them to every client before each call.

## Option B — Metered free account (50 GB/month)

1. Sign up at https://www.metered.ca/stun-turn (free tier).
2. Copy the credentials API URL they give you, it looks like:
   `https://<app>.metered.live/api/v1/turn/credentials?apiKey=<KEY>`
3. On Render add:  `TURN_REST_API = <that URL>`

## Option C — your own coturn server

    TURN_URL        = turn:your.host:3478,turns:your.host:5349?transport=tcp
    TURN_USERNAME   = ...
    TURN_CREDENTIAL = ...

## Other env flags

- `TURN_DISABLE=1` — turn off the zero-config stopgap (STUN only).
- Priority order: `TURN_URL` → `TURN_REST_API` → Cloudflare key → stopgap.

## Also worth knowing on Render's free plan

- The service **sleeps after ~15 min idle**; the first visitor waits up to
  ~1 minute while it wakes. Keep-alive pings from a free uptime monitor
  (e.g. UptimeRobot hitting `/api/ice` every 10 min) prevent that.
- WebSocket signaling and TURN relay both work fine on Render; nothing else
  to configure there.
