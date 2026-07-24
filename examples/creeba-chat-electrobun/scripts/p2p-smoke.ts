#!/usr/bin/env bun
/**
 * P2P smoke test for the `creeba-js` package: two `CreebaSync` instances (generic
 * core), each on its own `IrohMdnsTransport`, on the same machine. They join the
 * same topic, discover each other over mDNS, then exchange a payload via iroh.
 * Validates core + transport end to end.
 *
 *   CREEBA_DEBUG=1 bun scripts/p2p-smoke.ts
 */
import { CreebaSync } from "@streamline-pulse/creeba-core";
import { IrohMdnsTransport } from "@streamline-pulse/creeba-iroh-mdns";
import type { Peer } from "@streamline-pulse/creeba-core";

const TOPIC = "smoke-room";
const DISCOVER_MS = 45_000;

/** App payload for the test (creeba-js is generic: the shape is free). */
interface Msg {
  userId: string;
  body: string;
}

const name = (p: Peer): string =>
  typeof p.metadata?.name === "string" ? p.metadata.name : "?";

const a = new CreebaSync<Msg>({
  transport: new IrohMdnsTransport<Msg>(),
  identity: { userId: "A", metadata: { name: "alice" } },
  topic: TOPIC,
});
const b = new CreebaSync<Msg>({
  transport: new IrohMdnsTransport<Msg>(),
  identity: { userId: "B", metadata: { name: "bob" } },
  topic: TOPIC,
});

let aSeesB = false;
let bSeesA = false;
let bGotMsg = false;

a.on("peers", (peers) => {
  console.log("A sees:", peers.map(name));
  if (peers.some((p) => p.userId === "B")) aSeesB = true;
});
b.on("peers", (peers) => {
  console.log("B sees:", peers.map(name));
  if (peers.some((p) => p.userId === "A")) bSeesA = true;
});
b.on("data", (m) => {
  console.log("B receives:", m.userId, "→", m.body);
  if (m.userId === "A") bGotMsg = true;
});

const [ra, rb] = await Promise.all([a.start(), b.start()]);
console.log(`A ready ${ra.publicKey.slice(0, 12)}… | B ready ${rb.publicKey.slice(0, 12)}…`);
console.log(`Waiting for discovery on "${TOPIC}" (up to ${DISCOVER_MS / 1000}s)…`);

const start = Date.now();
const timer = setInterval(() => {
  if (aSeesB && bSeesA) {
    clearInterval(timer);
    console.log(
      `✅ Mutual discovery in ${((Date.now() - start) / 1000).toFixed(1)}s. Testing message A→B…`,
    );
    a.broadcast({ userId: "A", body: "hello from A" });
    setTimeout(() => {
      console.log(bGotMsg ? "✅ Message received by B. SUCCESS." : "❌ Message NOT received by B.");
      a.destroy();
      b.destroy();
      process.exit(bGotMsg ? 0 : 1);
    }, 4000);
  } else if (Date.now() - start > DISCOVER_MS) {
    clearInterval(timer);
    console.log(`❌ No mutual discovery (A sees B=${aSeesB}, B sees A=${bSeesA}).`);
    a.destroy();
    b.destroy();
    process.exit(1);
  }
}, 1000);
