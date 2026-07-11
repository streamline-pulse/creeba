# Creeba Chat (desktop)

Desktop encrypted P2P chat, built with **Electrobun** (Bun main process + system WebView):

- **DuckDB** (`@duckdb/node-api`): local portable database, one instance per app (`~/.creeba-chat-electrobun/chat.duckdb`). Persistence is the app's responsibility (`creeba-js` stores nothing).
- **Package [`creeba-js`](../../creeba-js)**: sync layer. Portable core (`CreebaSync`) + `IrohMdnsTransport` transport (iroh QUIC + mDNS discovery, no server or sidecar).

The app just **plugs** a local DuckDB store and the iroh/mDNS transport onto the `creeba-js` core — the very same core is reused on mobile (see `examples/creeba-chat-expo/src/sync`).

## Development

This app is **standalone**. It consumes the `creeba-js` package **by name**, like
a published dependency. Locally, link it once via `bun link`:

```bash
(cd ../../creeba-js && bun install && bun link)   # lib: native deps + register "creeba-js"
bun install                             # app dependencies (electrobun, iroh, duckdb, react…)
bun link creeba-js                      # symlink node_modules/creeba-js -> creeba-js

# Dev with HMR (recommended)
bun run dev:hmr

# Dev without HMR
bun run start
```

To run a **2nd local instance** (P2P test on the same machine), use a separate
DuckDB file (a single writer per database):

```bash
CREEBA_DATA_DIR=/tmp/creeba-b bun run start
```

## Architecture

```
src/
├── bun/
│   ├── index.ts     # Main: wires CreebaSync (DuckDB store + iroh transport) + RPC + window
│   └── db.ts        # ChatDB: local DuckDB persistence (identity + messages)
├── shared/chat.ts   # Electrobun RPC schema + app domain types
└── mainview/App.tsx # React UI
scripts/
├── postbuild.mjs    # Embeds the native modules (iroh + duckdb) into the .app
└── p2p-smoke.ts     # 2-node test: CREEBA_DEBUG=1 bun scripts/p2p-smoke.ts

# The P2P logic lives in the creeba package (repo root: core + iroh/mDNS transport).
```

## P2P: how it works

1. Each app binds an **iroh endpoint** (stable node-id per session) and listens for incoming connections.
2. It **advertises over mDNS** (`_creebachat._udp`) its iroh ticket + `{userId, name, room}` on the LAN.
3. It **discovers** other instances of the same room; to avoid duplicates, only the lower node-id dials, the other accepts.
4. Over the connection (encrypted QUIC), the two exchange length-prefixed NDJSON frames: `hello` (identity) then `data` (the chat message payload).

No server or network configuration for the "same network" case. iroh also handles holepunch/relay if you ever connect peers outside the LAN.

## Packaging & sharing

```bash
bun run build:canary
```

Produces in `artifacts/`:

- `canary-macos-arm64-CreebaChat-canary.dmg` — the file to send.
- `canary-macos-arm64-CreebaChat-canary.app.tar.zst` — the same app, compressed.

The Bun bundle marks `@duckdb/*` and `@number0/iroh` as `external` (native
bindings that can't be bundled). The `postBuild` hook (`scripts/postbuild.mjs`)
therefore embeds the **transitive closure of these native dependencies**
(`iroh.node`, `duckdb.node` + `libduckdb.dylib`) into
`Contents/Resources/app/node_modules`, keeping only the target platform.
`bonjour-service` is pure JS and stays bundled. In `dev`, this hook is a no-op
(resolution from the project's node_modules).

> Rebuild required after a `bun install` (the embedded native binaries must match
> the installed versions).

### On your friend's side (macOS, unsigned app)

The app is **not signed/notarized**: Gatekeeper will block it on first launch,
and _app translocation_ may make it read-only. You need to clear quarantine after
copying it to `/Applications` (or elsewhere):

```bash
xattr -dr com.apple.quarantine "/Applications/Creeba Chat-canary.app"
open "/Applications/Creeba Chat-canary.app"
```

Alternative: right-click the app → **Open** → **Open**.

Current constraints:

- **Same OS/arch** as the build: here `macos-arm64` (Apple Silicon).
- For clean distribution (double-click without tricks), you need an Apple
  Developer account and to enable `mac.codesign` + `mac.notarize` in `electrobun.config.ts`.
