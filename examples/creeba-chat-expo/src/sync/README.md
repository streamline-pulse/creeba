# Mobile sync layer (creeba)

Reuses the **same portable core** as the desktop (`CreebaSync` from the
`creeba-js` package): identity, presence, peers, the `hello` handshake, and
forwarding of opaque payloads. Only **the store** and **the transport** are
platform-specific; message shape and persistence live in this app.

- `types.ts` — app types (`ChatMessage`, `Profile`) and the shared protocol/service constants.
- `store.ts` — `SqliteStore`: **local** persistence via `expo-sqlite` (the mobile equivalent of DuckDB on desktop). The database stays local to the device.
- `transport.ts` — `StubTransport`: fallback (no P2P) for Expo Go / web.
- `useCreeba.ts` — React hook that assembles store + transport + core. It picks `IrohExpoTransport` (native) if available, otherwise `StubTransport`.

## Native iroh transport (implemented)

The real mobile P2P is provided by the **[`creeba-expo`](../../../../creeba-expo)**
package (native Swift/Kotlin module wrapping `iroh-ffi`). Same P2P as the desktop
(encrypted QUIC + mDNS), interoperable (same ALPN, wire format and mDNS service).

`@number0/iroh` (NAPI) doesn't run in Hermes; `iroh-ffi` provides precompiled
mobile bindings (Swift Package + Maven), hence the native module.

> ⚠️ Requires a **dev build** (`expo prebuild` + `run:ios`/`run:android`), not
> Expo Go. See the `creeba-expo` README (including the iOS SPM step).

## Getting started

```bash
# from examples/creeba-chat-expo
bunx expo install expo-sqlite      # align the version with the Expo SDK
bun install                        # app dependencies
bun link creeba-js                 # core (symlink node_modules/creeba-js)
bun link creeba-expo               # native iroh transport

# dev build (the native module does not work in Expo Go)
npx expo prebuild
npx expo run:ios     # or run:android
```

The `creeba-js` and `creeba-expo` packages are consumed **by name** (`link:`
locally), like published dependencies.

> Metro follows symlinks/exports; it may require
> `config.resolver.unstable_enablePackageExports = true` and adding the repo root
> to `config.watchFolders` in `metro.config.js`.
