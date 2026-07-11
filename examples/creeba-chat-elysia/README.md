# creeba × Elysia

A **server = P2P node** example. Elysia (on Bun) hosts the `CreebaSync` core with
the `IrohMdnsTransport` transport (iroh QUIC + mDNS discovery) and a local
`bun:sqlite` database. A **web client** (page served by the server) connects to it
over **WebSocket**: the browser does no P2P itself, it drives the node.

```
Browser (web client) ──WebSocket /ws──► Elysia (Bun)
                                          └─ CreebaSync + IrohMdnsTransport + bun:sqlite
                                               └─ iroh/QUIC ◄──► other Creeba nodes (desktop, another server…)
```

Why this split: `@number0/iroh` (NAPI) and mDNS (`node:dgram`) don't run in a
browser. The Bun server runs them natively — so it does the P2P and relays to the
browsers. The portable `creeba-js` core is identical to the desktop one; only the
store (`bun:sqlite`) and the host change.

## Run

```bash
# 1) lib (once): native deps + register the "creeba-js" package
(cd ../../creeba-js && bun install && bun link)

# 2) this example
bun install
bun link creeba-js  # symlink node_modules/creeba-js -> creeba-js
bun run dev
```

Open http://localhost:3000 in the browser.

### Testing P2P

Start a **second node** (different local database + different port) on the same
network — mDNS discovery links them and messages sync:

```bash
CREEBA_DATA_DIR=/tmp/creeba-chat-elysia-b PORT=3001 bun run dev
```

Or have this server talk to the **desktop** app (Electrobun): same room, same iroh
protocol, they discover each other on the LAN.

## Environment variables

- `PORT`: HTTP/WebSocket port (default `3000`).
- `CREEBA_ROOM`: room to join (default `creeba-chat`).
- `CREEBA_DATA_DIR`: local database folder (default `~/.creeba-chat-elysia`).
- `CREEBA_DEBUG=1`: iroh/mDNS transport logs.

## Files

```
src/
├── index.ts     # Elysia server: CreebaSync + transport + WebSocket + serving the client
├── store.ts     # SqliteStore (bun:sqlite) — local persistence, stays local
└── client.html  # browser UI (vanilla JS + WebSocket)
```

> The WebSocket only carries the UI (client ↔ _your_ server). The real encrypted
> P2P between nodes goes through iroh, server to server.
