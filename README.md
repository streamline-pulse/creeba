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

## Use in an Expo app (mobile)

On mobile the transport is provided by [`creeba-expo`](./creeba-expo), a native
module (Swift/Kotlin via `iroh-ffi`) that implements the same `SyncTransport`.
It speaks the same ALPN + wire format as the desktop, so mobile and desktop peers
interoperate on the LAN.

> **Requires a [dev build](https://docs.expo.dev/develop/development-builds/introduction/)**
> — the native module does **not** run in Expo Go.

### 1. Install

```bash
# published packages
npx expo install creeba-js creeba-expo

# or, from this monorepo, link them locally
bun link creeba-js && bun link creeba-expo
```

### 2. Register the config plugin

Add the plugin in `app.json` / `app.config.js`. It wires up the iOS local-network
permission + Bonjour service and the Android network/multicast permissions:

```json
{
  "expo": {
    "plugins": [
      ["creeba-expo", { "localNetworkUsageDescription": "MyApp uses the local network to discover nearby peers." }]
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
import { CreebaSync } from "creeba-js";
import { IrohExpoTransport } from "creeba-expo";

interface ChatMessage { id: string; userId: string; body: string; ts: number }

const sync = new CreebaSync<ChatMessage>({
  transport: new IrohExpoTransport<ChatMessage>(),
  identity: { userId: "abc", metadata: { name: "alice" } },
  topic: "creeba-chat",
});

sync.on("data", (message, from) => {/* persist locally + render */});
sync.on("peers", (peers) => {/* … */});

await sync.start();
sync.broadcast({ id: "1", userId: "abc", body: "hi", ts: Date.now() });
```

Tip: guard the native import so the app still runs in Expo Go / web (falling back
to a no-op transport), as shown in
[`examples/creeba-chat-expo/src/sync`](./examples/creeba-chat-expo/src/sync).

> **Monorepo / linked packages**: `creeba-expo` ships its own `node_modules` with
> possibly mismatched copies of `react-native` / `expo-modules-core`. Configure
> Metro to resolve a single instance of these from the app (see
> [`examples/creeba-chat-expo/metro.config.js`](./examples/creeba-chat-expo/metro.config.js)),
> otherwise you'll hit `PlatformConstants could not be found` at runtime.

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
