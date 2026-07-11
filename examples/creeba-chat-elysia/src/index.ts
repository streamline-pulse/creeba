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

// creeba-js is generic: the app fixes the protocol and the payload (ChatMessage).
const sync = new CreebaSync<ChatMessage>({
  transport: new IrohMdnsTransport<ChatMessage>({
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

// Payload received from a peer → persist (idempotent) + relay to web clients.
sync.on("data", (message) => {
  void store.insertMessage(message).catch(() => {});
  broadcast({ type: "message", message });
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
        sync.broadcast(message);
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
