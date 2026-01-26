# Worldify: Rapid Survival

A minimal real-time multiplayer web game prototype.

## Tech Stack

- **Client**: React + Three.js + Zustand (Vite)
- **Server**: Node.js + WebSocket (ws)
- **Shared**: TypeScript protocol definitions
- **Deploy**: Netlify (client) + OVH VPS with Docker (server)

## Development

### Prerequisites

- Node.js 20+

### Setup

```bash
npm install
```

### Run Development

```bash
npm run dev
```

This starts:
- Server on http://localhost:8080
- Client on http://localhost:5173

### Build

```bash
npm run build
```

## Project Structure

```
├── client/          # React + Three.js client
├── server/          # Node.js WebSocket server
├── shared/          # Shared protocol & utilities
├── ops/             # Docker & deployment configs
└── .github/         # GitHub Actions workflows
```

## Deployment

- **Client**: Auto-deploys to Netlify on push to main
- **Server**: Auto-deploys to OVH via GitHub Actions on push to main

## License

Private - All rights reserved
