---
title: Use in an Expo app
description: The native mobile transport (Swift/Kotlin via iroh-ffi), interoperable with desktop.
---

On mobile the transport is provided by `@streamline-pulse/creeba-expo`, a native
module (Swift/Kotlin via `iroh-ffi`) that implements the same `SyncTransport`. It
speaks the same ALPN + wire format as the desktop, so mobile and desktop peers
interoperate on the LAN.

:::caution
Requires a [dev build](https://docs.expo.dev/develop/development-builds/introduction/)
— the native module does **not** run in Expo Go.
:::

## 1. Install

```bash
npx expo install @streamline-pulse/creeba-core @streamline-pulse/creeba-expo
```

## 2. Register the config plugin

In `app.json` / `app.config.js` — it wires up the iOS local-network permission +
Bonjour service and the Android network/multicast permissions:

```json
{
  "expo": {
    "plugins": [
      ["@streamline-pulse/creeba-expo", { "localNetworkUsageDescription": "MyApp uses the local network to discover nearby peers." }]
    ]
  }
}
```

## 3. Prerequisites & prebuild

- **iOS**: minimum deployment target **17.5** (set by the plugin), and the
  `cocoapods-spm` gem (`gem install cocoapods-spm`) so the iroh-ffi Swift Package
  resolves.
- **Android**: no extra step — the plugin adds the permissions and the JNA
  dependency automatically.

```bash
npx expo prebuild
npx expo run:ios      # or: npx expo run:android
```

## 4. Wire the transport

Use `IrohExpoTransport` exactly like `IrohMdnsTransport` on desktop:

```ts
import { CreebaSync } from '@streamline-pulse/creeba-core'
import { IrohExpoTransport } from '@streamline-pulse/creeba-expo'

const sync = new CreebaSync<ChatMessage>({
  transport: new IrohExpoTransport<ChatMessage>(),
  identity: { userId: 'abc', metadata: { name: 'alice' } },
  topic: 'creeba-chat',
})
await sync.start()
```

:::note
In a monorepo, configure Metro to resolve a single instance of
`react-native` / `expo-modules-core` from the app, otherwise you'll hit
`PlatformConstants could not be found` at runtime.
:::
