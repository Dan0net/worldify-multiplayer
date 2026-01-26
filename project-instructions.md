# PROJECT_INSTRUCTIONS.md — Worldify (React + Three.js) Multiplayer Prototype
Domain: worldify.xyz

Goal: ship a super-minimal real-time multiplayer web prototype from scratch.
- UI: React (landing/join HUD/tool selection/debug).
- Game: Three.js first-person movement (look/move/jump), see other players.
- Multiplayer: Node.js WebSocket server supports multiple rooms (64 players each).
- Lobby: players always join the current open room; when it fills, server creates a new room.
- Movement: super lightweight binary messages, unordered/losy is OK (no strict ordering).
- Build commands: server-authoritative strict ordering, replayable after flaky reconnect.
- Monorepo: `shared/` is used by both client and server to keep protocol consistent.
- Hands-off: push-to-main deploys client to Netlify and server to OVH automatically.
- Deploy stack on OVH: simplest Docker Compose with just `caddy` + `server`.

This file is instructions only. Keep implementation simple and minimal.

---

## 0) Services used (minimal)

1) Netlify — static hosting for client at `game.worldify.xyz`.
2) OVH VPS — always-on server at `api.worldify.xyz` (Docker Compose).
3) GitHub — repo + Actions for automated server deploy.

Later (optional): Cloudflare R2 for large assets at `assets.worldify.xyz`, but not now.

---

## 1) Game concept (fun + simple)

### Name
Worldify: Rapid Survival

### Pitch
You spawn into a shared arena with 64 players. The safe zone is “your territory”. If you don’t expand your territory quickly, you get consumed.

### Objective (simple and popular-feeling)
Think “battle royale survival” but with building instead of shooting:
- Each player has a **Territory Core** (a point).
- You **expand territory** by placing build pieces that connect outward:
  - floors, walls, slopes
- A global danger “consume wave” advances inward or expands from other players’ territory edges.
- If your core becomes disconnected from your territory (or gets fully consumed), you’re eliminated.

Prototype version (barebones):
- Territory is just a grid ownership map.
- Build pieces “claim” cells around them.
- Server periodically applies a “consume” rule:
  - unclaimed cells shrink or are removed
  - players without enough claimed cells are flagged
- You win by being the last surviving core, or by holding the most territory after a time limit.

Solo fun (1 player):
- Time-trial: expand territory to reach a target area before the consume wave catches you.
- Build speed challenge: survive X minutes with minimal pieces.

Keep the prototype super light:
- No combat.
- No complex resources.
- Just movement + building + territory growth + survival timer.

---

## 2) One-time decisions (constants)

Put these values in `shared/src/protocol/constants.ts`.

- MAX_PLAYERS_PER_ROOM: 64
- SERVER_TICK_HZ: 20
- SNAPSHOT_HZ: 10–15
- CLIENT_INPUT_HZ: 20–30
- TERRITORY_GRID_SIZE: choose something small (e.g. 128x128) for prototype
- TERRITORY_CELL_SIZE: e.g. 2m
- BUILD_STRICT_ORDER: server uses `buildSeq` (uint32) per room

---

## 3) Repo structure (monorepo)

IMPORTANT: keep this exact structure and names.

repo/
  client/
    index.html
    package.json
    vite.config.js
    src/
      main.tsx
      App.tsx
      ui/
        Landing.tsx
        Hud.tsx
        DebugPanel.tsx
      game/
        createGame.ts
        GameCore.ts
        scene/
          scene.ts
          camera.ts
          lighting.ts
        player/
          playerLocal.ts
          playerRemote.ts
          controls.ts
        world/
          territory.ts
          buildPreview.ts
          buildPieces.ts
      net/
        netClient.ts
        decode.ts
        encode.ts
      state/
        store.ts
        bridge.ts
  server/
    package.json
    tsconfig.json
    src/
      index.ts
      http/
        routes.ts
      ws/
        wsServer.ts
      rooms/
        roomManager.ts
        room.ts
        roomTick.ts
        territory.ts
        buildLog.ts
      net/
        decode.ts
        encode.ts
  shared/
    package.json
    tsconfig.json
    src/
      protocol/
        version.ts
        msgIds.ts
        constants.ts
        movement.ts
        snapshot.ts
        build.ts
        territory.ts
      util/
        bytes.ts
        quantize.ts
  ops/
    docker-compose.yml
    Caddyfile
    bootstrap_ovh.sh
    deploy_server.sh
  .github/
    workflows/
      deploy_server.yml
  netlify.toml
  package.json
  tsconfig.base.json
  README.md

Notes:
- `shared/` is a real package used by both `client/` and `server/`.
- `client/` is React + Three.js (Three runs imperatively; React renders UI).
- `ops/` is the only ops folder needed.

---

## 4) React UI + game core state management (simple)

### Golden rule
Game core owns real-time state. React UI displays a summary and sends high-level commands.

### Recommended: Zustand store as the UI bridge
Use Zustand for a tiny shared store that holds:
- connection status
- room id
- player count
- ping
- current tool selection (wall/floor/slope)
- lastBuildSeqSeen
- territory size stats (optional)
- debug stats (fps, tick ms)

Game core should NOT store large per-frame data in Zustand.

### Data flow
- React -> Game core:
  - “Join”
  - “Select tool”
  - “Place build”
- Game core -> Zustand:
  - “Connected / disconnected”
  - “Room info”
  - “Ping”
  - “Last build seq applied”
  - “Player count”
  - “Debug metrics”

Update frequency:
- Zustand updates 5–10 Hz or event-driven (join/leave).
- Game render loop stays independent (60 fps).

---

## 5) Server behavior (simple + authoritative)

### 5.1 Process model
Single Node process, many rooms in memory.
- One HTTP server:
  - POST /api/join
  - GET /healthz
- One WebSocket endpoint:
  - /ws

### 5.2 Lobby / room assignment
- `currentRoomId` is always an open room.
- `POST /api/join` returns:
  - roomId
  - playerId
  - token
  - protocol version
- When room reaches 64 players:
  - close room for joins
  - create next room
  - rotate `currentRoomId`

Room cleanup:
- destroy empty rooms after 60s.

### 5.3 Territory + survival loop (prototype)
Per room:
- territory grid: small 2D array with owner id (uint16)
- each player has a “core” position on the grid
- building claims territory cells near placed pieces
- a periodic “consume” step runs (e.g., every 1s):
  - shrink unclaimed/weak territory
  - remove disconnected territory islands (optional)
  - mark players eliminated if core is exposed or territory below threshold

Keep this extremely simple:
- no pathfinding
- no expensive flood fill unless necessary
- if you do connectivity, do it rarely (e.g., every 5–10s) or approximate

---

## 6) Networking: binary protocol + strict build ordering

All messages are binary frames with a tiny header:
- byte 0: msgId (uint8)
- byte 1..: payload

Msg IDs and binary layouts are defined in `shared/`.

### 6.1 Required message types (minimum set)

Client -> Server:
- JOIN (optional if join is done via URL params + token; still supported)
- INPUT (movement input)
- BUILD_INTENT (place wall/floor/slope)
- ACK_BUILD (optional; last buildSeq applied)
- PING (optional)

Server -> Client:
- WELCOME
- ROOM_INFO
- SNAPSHOT (movement + minimal room info)
- BUILD_COMMIT (strict order)
- BUILD_SYNC (batched replay)
- ERROR
- PONG (optional)

### 6.2 Movement (unordered / lossy)
- client sends INPUT at 20–30 Hz
- server uses “latest input per player”
- server broadcasts SNAPSHOT at 10–15 Hz
- client interpolates remote players

Keep movement messages tiny:
- bitmask buttons
- quantized yaw/pitch
- optional small move vector or inferred from buttons

### 6.3 Build commands (strict order + replay)
Per room:
- buildSeq: uint32
- buildLog: append-only list of commits (capped)

Server build flow:
1) validate
2) buildSeq++
3) append buildLog
4) broadcast BUILD_COMMIT with buildSeq

Reconnect:
- client provides lastBuildSeqSeen (in JOIN or via query param)
- server sends BUILD_SYNC:
  - fromSeq, toSeq, packed commits in order

Client:
- apply strictly in buildSeq order
- dedupe by buildSeq
- if missing seq, buffer until complete then apply

---

## 7) Local development (one command)

Prereqs:
- Node 20+

Root scripts:
- `npm run dev` starts:
  - server on localhost:8080
  - client (Vite) on localhost:5173

Client env (dev):
- VITE_API_BASE=http://localhost:8080
- VITE_WS_URL=ws://localhost:8080/ws

---

## 8) Deployment — fully automated (hands-off)

### 8.1 DNS plan (worldify.xyz)

- game.worldify.xyz  -> Netlify site
- api.worldify.xyz   -> OVH VPS public IP
- (later) assets.worldify.xyz -> Cloudflare R2

### 8.2 Netlify (client)
- Connect Netlify site to GitHub repo.
- Netlify builds on push to main using `netlify.toml`.
- Set env vars in Netlify:
  - VITE_API_BASE=https://api.worldify.xyz
  - VITE_WS_URL=wss://api.worldify.xyz/ws

### 8.3 OVH VPS (server) — simplest Docker Compose: Caddy + server

We run exactly two containers:
- caddy: reverse proxy + automatic TLS
- server: Node WebSocket server

No host-level Caddy install. Just Docker.

OVH one-time setup:
1) Create VPS (Ubuntu).
2) SSH in.
3) Run `ops/bootstrap_ovh.sh` once:
   - installs Docker + docker compose plugin
   - creates a non-root deploy user
   - sets firewall: allow 22, 80, 443 only
   - creates /opt/worldify and copies ops files
   - starts docker compose (caddy + server)

Caddy handles:
- TLS certificates automatically
- WebSocket upgrade proxying
- forwarding:
  - https://api.worldify.xyz/api/* -> server
  - wss://api.worldify.xyz/ws     -> server

Server container:
- listens on 0.0.0.0:8080 inside container
- uses env for CORS + limits

### 8.4 Automated deploy to OVH from GitHub Actions

Workflow deploy_server.yml:
- triggers on push to main when server/ or shared/ changes
- builds a server Docker image
- pushes to GHCR
- SSH into OVH and runs `ops/deploy_server.sh` which:
  - docker login ghcr
  - docker compose pull
  - docker compose up -d
  - curl /healthz and fail if not 200

GitHub secrets needed:
- OVH_HOST
- OVH_DEPLOY_USER
- OVH_SSH_KEY
- GHCR_TOKEN (or use GitHub token with proper permissions)

Outcome:
- merge to main -> server deploys automatically
- merge to main -> Netlify deploys client automatically

---

## 9) Minimal operational safeguards (do these now)

1) Protocol version gate:
   - client sends version
   - server rejects mismatched versions
2) Rate limits:
   - max joins per IP per minute
   - max build intents per second per player
3) Log caps:
   - buildLog ring buffer cap
4) Health endpoint:
   - /healthz includes room count, player count
5) Basic metrics in logs:
   - snapshot size bytes
   - tick time ms