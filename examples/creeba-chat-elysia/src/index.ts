import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { CreebaSync } from "creeba-js";
import type { Peer as CreebaPeer } from "creeba-js";
import { IrohMdnsTransport } from "creeba-js/iroh-mdns";
import { SqliteStore, type ChatMessage } from "./store.ts";

const ROOM = process.env.CREEBA_ROOM ?? "creeba-chat";
const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.CREEBA_DATA_DIR ?? join(homedir(), ".creeba-chat-elysia");
mkdirSync(DATA_DIR, { recursive: true });

// Chat protocol/ALPN + mDNS service (interop with desktop/mobile).
const CHAT_PROTOCOL = "creeba/chat/0";
const CHAT_SERVICE_TYPE = "creebachat";

// The P2P node lives in the server process: iroh/mDNS + local bun:sqlite database.
const store = new SqliteStore(join(DATA_DIR, "chat.sqlite"));
let identity = await store.getOrCreateIdentity();

// The app payload is a small union: live messages + a request/response backfill
// so a node that just joined can pull the history it missed. creeba-js stays
// generic (opaque payload); this protocol is entirely defined here.
type Wire =
  | { t: "msg"; msg: ChatMessage }
  | { t: "sync-req"; since: number }
  | { t: "sync-res"; items: ChatMessage[] };

const sync = new CreebaSync<Wire>({
  transport: new IrohMdnsTransport<Wire>({
    protocol: CHAT_PROTOCOL,
    serviceType: CHAT_SERVICE_TYPE,
  }),
  identity: { userId: identity.userId, metadata: { name: identity.name } },
  topic: ROOM,
});

// Project a generic peer (free metadata) onto the displayed peer (name).
const toPeer = (p: CreebaPeer) => ({
  peerId: p.peerId,
  userId: p.userId,
  name: typeof p.metadata?.name === "string" ? p.metadata.name : "?",
});

// WebSocket clients (browsers) connected to THIS server. The server relays P2P
// events to them and pushes their messages to the peers.
type Client = { send: (data: unknown) => void };
const clients = new Set<Client>();
function broadcast(payload: unknown): void {
  for (const ws of clients) {
    try {
      ws.send(payload);
    } catch {
      /* client gone */
    }
  }
}

// Persist a message and, only if it's new, relay it to the web clients.
async function ingest(msg: ChatMessage): Promise<void> {
  if (await store.insertMessage(msg)) broadcast({ type: "message", message: msg });
}

sync.on("data", (frame, from) => {
  switch (frame.t) {
    case "msg":
      void ingest(frame.msg);
      break;
    case "sync-req":
      // A peer asks for what it missed → reply with our delta since its cursor.
      if (from) sync.send(from.peerId, { t: "sync-res", items: store.messagesSince(ROOM, frame.since) });
      break;
    case "sync-res":
      for (const msg of frame.items) void ingest(msg);
      break;
  }
});

// Backfill: when a peer joins, pull the history we're missing from it. Both
// sides do this symmetrically; duplicates are dropped by the idempotent insert.
sync.on("peer", (peer) => {
  sync.send(peer.peerId, { t: "sync-req", since: store.latestTs(ROOM) });
});

sync.on("peers", (peers) => broadcast({ type: "peers", peers: peers.map(toPeer) }));
sync.on("status", (status) => broadcast({ type: "status", status }));

const { publicKey } = await sync.start();
console.log(
  `🦊 Creeba × Elysia — ${identity.name} (${publicKey.slice(0, 12)}…) room="${ROOM}"`,
);

const app = new Elysia()
  .get("/", () => new Response(Bun.file(join(import.meta.dir, "client.html"))))
  .ws("/ws", {
    async open(ws) {
      clients.add(ws as unknown as Client);
      ws.send({
        type: "init",
        identity,
        status: sync.status(),
        peers: sync.peers().map(toPeer),
        messages: await store.recentMessages(ROOM),
      });
    },
    async message(ws, raw) {
      const data = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
        type?: string;
        body?: string;
        name?: string;
      };
      if (data.type === "send" && data.body?.trim()) {
        const message: ChatMessage = {
          id: crypto.randomUUID(),
          room: ROOM,
          userId: identity.userId,
          name: identity.name,
          body: data.body,
          ts: Date.now(),
        };
        await store.insertMessage(message);
        sync.broadcast({ t: "msg", msg: message });
        broadcast({ type: "message", message });
      } else if (data.type === "setName" && data.name?.trim()) {
        identity = { ...identity, name: data.name.trim() };
        await store.setName(identity.userId, identity.name);
        sync.setIdentity({ userId: identity.userId, metadata: { name: identity.name } });
        broadcast({ type: "identity", identity });
      }
    },
    close(ws) {
      clients.delete(ws as unknown as Client);
    },
  })
  .listen(PORT);

console.log(`🌐 Web client: http://localhost:${app.server?.port}`);

process.on("SIGINT", () => {
  sync.destroy();
  process.exit(0);
});
