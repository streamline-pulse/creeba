# Creeba

Creeba is a **local-first P2P layer** for TypeScript apps. Local databases stay
local — the network only carries **opaque app payloads**, never the database.
The message shape and its persistence belong to the application.

It ships as small, composable packages under the `@streamline-pulse` scope, split
so that native/ORM dependencies never leak into environments that can't use them
(a browser or mobile bundle never pulls the iroh native binding; the core never
pulls Prisma).

| Package | What it is | Native deps |
|---|---|---|
| [`@streamline-pulse/creeba-core`](./creeba-core) | Portable P2P core: identity, presence, peers, routing of opaque payloads over a pluggable `SyncTransport`. | none |
| [`@streamline-pulse/creeba-iroh-mdns`](./creeba-iroh-mdns) | Bun/Node transport: encrypted QUIC (iroh, holepunch + relay) with **LAN** discovery over mDNS, serverless. + ed25519 identity helpers. | `@number0/iroh` |
| [`@streamline-pulse/creeba-expo`](./creeba-expo) | Mobile transport (Expo/React Native): native iroh via `iroh-ffi` (Swift/Kotlin), same ALPN + wire format as desktop. | native module |
| [`@streamline-pulse/creeba-oplog`](./creeba-oplog) | Portable op-log: hybrid logical clock, operation journal, LWW convergence. Persistence-agnostic. | none |
| [`@streamline-pulse/creeba-oplog-prisma`](./creeba-oplog-prisma) | Prisma binding for the op-log: transparent mutation capture (`$extends`), ready-made `OpStore` + `Projection`. | Prisma (peer) |

## Layered architecture

```
Your app
├── CreebaSync (creeba-core)          — portable, no native dependency
│     └── SyncTransport  ← P2P network (pluggable)
│           ├── IrohMdnsTransport  (creeba-iroh-mdns)  — Bun/desktop/server, LAN
│           └── IrohExpoTransport  (creeba-expo)       — mobile, same wire format
└── OpLog (creeba-oplog)              — optional convergence layer (HLC + LWW)
      ├── OpStore     ← journal persistence (pluggable)
      └── Projection  ← domain-state writes (pluggable)
            └── creeba-oplog-prisma   — a ready OpStore + Projection over Prisma
```

The two layers are independent: use `creeba-core` alone to move payloads, add
`creeba-oplog` when you need convergent state across nodes. Persistence is never
part of a core — each app plugs its own store (DuckDB, `bun:sqlite`,
`expo-sqlite`, Prisma…).

## Install

```bash
# transport + core (Bun / desktop / server)
bun add @streamline-pulse/creeba-core @streamline-pulse/creeba-iroh-mdns

# convergence layer (optional)
bun add @streamline-pulse/creeba-oplog
bun add @streamline-pulse/creeba-oplog-prisma   # if you use Prisma
```

## Usage (desktop / Bun)

The core is generic over the app payload `T`. The app defines its own message
type and handles persistence itself.

```ts
import { CreebaSync } from "@streamline-pulse/creeba-core";
import { IrohMdnsTransport } from "@streamline-pulse/creeba-iroh-mdns";

interface ChatMessage { id: string; userId: string; body: string; ts: number }

const sync = new CreebaSync<ChatMessage>({
  transport: new IrohMdnsTransport<ChatMessage>(),
  identity: { userId: "abc", metadata: { name: "alice" } },
  topic: "creeba-chat",
});

sync.on("data", (message, from) => {/* received from a peer → persist + display */});
sync.on("peer", (peer) => {/* a peer joined → good place to backfill history */});
sync.on("peers", (peers) => {/* full peer list changed */});
sync.on("status", (s) => {/* s.ready, s.publicKey */});

const { publicKey } = await sync.start();  // bind + join the topic
sync.broadcast({ id: "1", userId: "abc", body: "hi", ts: Date.now() });
```

### Backfilling history on join

The core carries only live payloads and stores nothing, so replaying the history
a late peer missed is an **app concern**. `CreebaSync` gives you the hook — the
`peer` event (fired once when a peer is identified) — and point-to-point
`send(peerId, payload)`; the app owns the cursor, ordering and dedup.

The recommended shape is a **pull** (request/response) rather than each peer
pushing its whole history. Model it inside your own payload union:

```ts
type Wire =
  | { t: "msg"; msg: ChatMessage }
  | { t: "sync-req"; since: number }        // requester's cursor
  | { t: "sync-res"; items: ChatMessage[] };

// On join, ask the new peer for what we're missing.
sync.on("peer", (peer) => sync.send(peer.peerId, { t: "sync-req", since: store.latestTs() }));

sync.on("data", (frame, from) => {
  if (frame.t === "sync-req" && from) sync.send(from.peerId, { t: "sync-res", items: store.since(frame.since) });
  else if (frame.t === "sync-res") for (const m of frame.items) store.insert(m); // idempotent by id
  else if (frame.t === "msg") store.insert(frame.msg);
});
```

Dedup by message `id` (idempotent inserts) makes this robust even if several
peers answer. A full working reference lives in
[`examples/creeba-chat-elysia`](./examples/creeba-chat-elysia/src/index.ts).

For **convergent state** (not just a message log), use the op-log layer below
instead of hand-rolling the merge.

## Convergence with the op-log

`creeba-oplog` turns mutations into an ordered, mergeable journal (hybrid logical
clock + last-writer-wins), independent of any database. The app implements two
interfaces — `OpStore` (journal persistence) and `Projection` (domain writes) —
or plugs in a ready binding. With Prisma, capture is transparent:

```ts
import { createOpLog } from "@streamline-pulse/creeba-oplog-prisma";

// $extends the client: every write to a syncable entity is journaled,
// scalar-only (relations dropped), secrets omitted.
const { client, oplog, projection } = createOpLog(prisma, {
  nodeId,
  syncable: [
    { model: "projects", entity: "Projects", orgField: "groupId" },
    // …
  ],
});

// Feed remote ops in, broadcast local ops out — over creeba-core:
oplog.onLocalOp((op) => sync.broadcast(op));
sync.on("data", (op) => oplog.applyRemote(op, projection));
```

## Use in an Expo app (mobile)

On mobile the transport is provided by
[`@streamline-pulse/creeba-expo`](./creeba-expo), a native module (Swift/Kotlin
via `iroh-ffi`) that implements the same `SyncTransport`. It speaks the same ALPN
+ wire format as the desktop, so mobile and desktop peers interoperate on the LAN.

> **Requires a [dev build](https://docs.expo.dev/develop/development-builds/introduction/)**
> — the native module does **not** run in Expo Go.

### 1. Install

```bash
npx expo install @streamline-pulse/creeba-core @streamline-pulse/creeba-expo
```

### 2. Register the config plugin

Add the plugin in `app.json` / `app.config.js`. It wires up the iOS local-network
permission + Bonjour service and the Android network/multicast permissions:

```json
{
  "expo": {
    "plugins": [
      ["@streamline-pulse/creeba-expo", { "localNetworkUsageDescription": "MyApp uses the local network to discover nearby peers." }]
    ]
  }
}
```

`localNetworkUsageDescription` is optional (a sensible default is used).

### 3. Prerequisites & prebuild

- **iOS**: minimum deployment target **17.5** (set by the plugin), and the
  `cocoapods-spm` gem must be installed so the iroh-ffi Swift Package resolves:

  ```bash
  gem install cocoapods-spm
  ```

- **Android**: no extra step — the plugin adds the permissions and the JNA
  dependency automatically.

Then generate the native projects and run a dev build:

```bash
npx expo prebuild
npx expo run:ios      # or: npx expo run:android
```

### 4. Wire the transport into the core

Use `IrohExpoTransport` exactly like `IrohMdnsTransport` on desktop. The app owns
its message type and its local persistence (e.g. `expo-sqlite`):

```ts
import { CreebaSync } from "@streamline-pulse/creeba-core";
import { IrohExpoTransport } from "@streamline-pulse/creeba-expo";

const sync = new CreebaSync<ChatMessage>({
  transport: new IrohExpoTransport<ChatMessage>(),
  identity: { userId: "abc", metadata: { name: "alice" } },
  topic: "creeba-chat",
});
await sync.start();
```

Tip: guard the native import so the app still runs in Expo Go / web (falling back
to a no-op transport), as shown in
[`examples/creeba-chat-expo/src/sync`](./examples/creeba-chat-expo/src/sync).

> **Monorepo / linked packages**: `creeba-expo` ships its own `node_modules` with
> possibly mismatched copies of `react-native` / `expo-modules-core`. Configure
> Metro to resolve a single instance of these from the app (see
> [`examples/creeba-chat-expo/metro.config.js`](./examples/creeba-chat-expo/metro.config.js)),
> otherwise you'll hit `PlatformConstants could not be found` at runtime.

## Discovery: LAN today, WAN next

Discovery in `creeba-iroh-mdns` is **mDNS = local network only** — it does not
cross routers. The iroh **connection** itself already traverses the internet
(QUIC holepunch + public relays) *once you have a peer's ticket*; what mDNS
provides is finding that ticket on the LAN.

Internet (WAN) rendezvous is on the roadmap as a **separate** discovery package
(e.g. `creeba-iroh-dns` / bootstrap-ticket) layered over a shared `creeba-iroh`
transport core, so `creeba-iroh-mdns` stays the LAN variant and the public API is
unchanged.

## Writing a transport

Implement `SyncTransport`: `start()` (returns the local id), `join(topic)`,
`setIdentity()`, `send(peerId, frame)`, `broadcast(frame)`, `destroy()`, and an
`on(event, cb)` emitting `peer-open` / `peer-close` / `frame` / `error`. The
transport ignores frame semantics (`hello`/`data`): it carries frames, the core
does the rest.

## Build & publish

Each package builds to `dist/` (ESM `.js` + `.d.ts` + source maps) via `tsc`
(`rewriteRelativeImportExtensions` keeps `.ts` specifiers in source and emits
`.js`; a small post-step aligns the declaration files). `publishConfig.access` is
`public` on every package.

```bash
# build (respect dependency order: core → oplog → oplog-prisma → iroh-mdns)
for p in creeba-core creeba-oplog creeba-oplog-prisma creeba-iroh-mdns; do (cd $p && bun run build); done

# publish (core first, so dependents resolve its published types)
cd creeba-core && npm publish
cd ../creeba-oplog && npm publish
cd ../creeba-oplog-prisma && npm publish
cd ../creeba-iroh-mdns && npm publish
```

`prepublishOnly` rebuilds automatically. During local development the packages
are linked (`bun link`) so dependents resolve each other from disk; published
dependents reference concrete versions (`^0.1.0`).

## Dev & test

```bash
# 2-node P2P test (mDNS discovery + iroh exchange), from the electrobun example:
cd examples/creeba-chat-electrobun
CREEBA_DEBUG=1 bun scripts/p2p-smoke.ts
```

## License

MIT © Streamline Pulse
