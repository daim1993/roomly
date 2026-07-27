# Roomly

Roomly is a small, account-free browser meeting app. People who open the same room link can talk with microphone-only mode or microphone and camera mode.

## Run locally

```sh
npm install
npm start
```

Open `http://localhost:3000`, enter a name, and share the invitation link shown after joining. Open that link in another browser or device to test a call.

## Production notes

- Deploy behind HTTPS. Browsers only allow camera and microphone access on HTTPS or `localhost`.
- Configure the reverse proxy to pass WebSocket traffic on `/signal`.
- The default public STUN servers work for many connections. For reliable calls across restrictive networks, configure `TURN_URL`, `TURN_USERNAME`, and `TURN_CREDENTIAL`.
- This app uses direct peer-to-peer mesh connections and defaults to 12 people per room. Set `MAX_ROOM_SIZE` to change the limit. For large meetings, use an SFU instead.

Optional environment variables: `PORT`, `HOST`, `MAX_ROOM_SIZE`, `TURN_URL` (comma-separated URLs), `TURN_USERNAME`, and `TURN_CREDENTIAL`.
