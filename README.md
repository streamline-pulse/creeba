# creeba

Bun library: Creeba's P2P sync layer. A **portable core** (identity, presence,
peers, routing of opaque app payloads) plus **pluggable transports**. Local
databases stay local — P2P only carries payloads, never the database. The
message shape and its persistence belong to the application.

The package lives in **`creeba-js/`** and ships under the name `creeba-js`. The
demo apps (`examples/`) consume it **by its package name**, like a published
dependency. Locally (before publishing) they are linked via `bun link` (a direct
symlink to `creeba-js/`; no tree copy):

```bash
cd creeba-js && bun link  # registers the "creeba-js" package
cd ../examples/creeba-chat-electrobun && bun link creeba-js   # (same for creeba-chat-expo, creeba-chat-elysia)
```

Their `package.json` declares `"creeba-js": "link:creeba-js"` — replace it with a
version (`"creeba-js": "^0.1.0"`) once the package is published.

## Layered architecture

```
CreebaSync (core, fully portable — no native dependency)
└── SyncTransport ← P2P network (pluggable)
      ├── IrohMdnsTransport  (Bun/desktop, Elysia): iroh QUIC + mDNS, serverless
      └── IrohExpoTransport  (mobile): native iroh-ffi module (Swift/Kotlin), same wire format
```

Persistence is **not** part of the core: each app plugs in its own local store
(DuckDB on desktop, `expo-sqlite` on mobile, `bun:sqlite` on the server).

- `creeba-js` (`creeba-js/src/index.ts`): core + interfaces + types. No native dependency → importable from Bun, Node, React Native/Expo.
- `creeba-js/iroh-mdns` (`creeba-js/src/transports/iroh-mdns.ts`): Bun transport (imports `@number0/iroh` + `bonjour-service`, kept out of the mobile bundle).
- [`creeba-expo`](./creeba-expo): separate package, native iroh transport for Expo/React Native (Swift + Kotlin via `iroh-ffi`). Interoperates with desktop/Elysia (same ALPN, wire format, mDNS).

## Structure

```
creeba-js/                # "creeba-js" package (portable core, published under this name)
└── src/
    ├── index.ts          # public exports
    ├── core.ts           # CreebaSync (portable orchestrator)
    ├── types.ts          # Identity, Peer, Status, WireFrame
    ├── emitter.ts        # typed event emitter (no node:events)
    ├── transport.ts      # SyncTransport interface
    └── transports/
        └── iroh-mdns.ts  # iroh + mDNS transport (Bun)
creeba-expo/              # separate package: native Expo iroh transport (Swift/Kotlin)
examples/
├── creeba-chat-electrobun/  # Electrobun + DuckDB (iroh/mDNS transport)
├── creeba-chat-elysia/      # Elysia (Bun): P2P node + web client (WebSocket)
└── creeba-chat-expo/        # Expo + expo-sqlite + creeba-expo (native P2P)
```

## Usage (desktop / Bun)

The core is generic over the app payload `T`. The app defines its own message
type and handles persistence itself.

```ts
import { CreebaSync } from "creeba-js";
import { IrohMdnsTransport } from "creeba-js/iroh-mdns";

interface ChatMessage { id: string; userId: string; body: string; ts: number }

const sync = new CreebaSync<ChatMessage>({
  transport: new IrohMdnsTransport<ChatMessage>(),
  identity: { userId: "abc", metadata: { name: "alice" } },
  topic: "creeba-chat",
});

sync.on("data", (message, from) => {/* received from a peer → persist + display */});
sync.on("peers", (peers) => {/* … */});
sync.on("status", (s) => {/* s.ready, s.publicKey */});

const { publicKey } = await sync.start();  // bind + join the topic
sync.broadcast({ id: "1", userId: "abc", body: "hi", ts: Date.now() });
```

## Writing a transport

Implement `SyncTransport`: `start()` (returns the local id), `join(topic)`,
`setIdentity()`, `send(peerId, frame)`, `broadcast(frame)`, `destroy()`, and an
`on(event, cb)` emitting `peer-open` / `peer-close` / `frame` / `error`. The
transport ignores frame semantics (`hello`/`data`): it carries frames, the core
does the rest.

## Dev & test

```bash
cd creeba-js && bun install                   # library dependencies

# 2-node P2P test (mDNS discovery + iroh exchange), from the electrobun example:
cd ../examples/creeba-chat-electrobun
CREEBA_DEBUG=1 bun scripts/p2p-smoke.ts
```
