import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { BrowserWindow, BrowserView, Updater } from "electrobun/bun";
import { CreebaSync } from "@streamline-pulse/creeba-core";
import type { Peer as CreebaPeer } from "@streamline-pulse/creeba-core";
import { IrohMdnsTransport } from "@streamline-pulse/creeba-iroh-mdns";
import { ChatDB } from "./db.ts";
import {
  CHAT_PROTOCOL,
  CHAT_SERVICE_TYPE,
  DEFAULT_ROOM,
  type ChatMessage,
  type ChatRPC,
  type Identity,
  type Peer,
  type Wire,
} from "../shared/chat.ts";

const DEV_SERVER_URL = "http://localhost:5173";

async function getMainViewUrl(): Promise<string> {
  const channel = await Updater.localInfo.channel();
  if (channel === "dev") {
    try {
      await fetch(DEV_SERVER_URL, { method: "HEAD" });
      return DEV_SERVER_URL;
    } catch {
      console.log("Vite dev server not running. Run 'bun run dev:hmr' for HMR.");
    }
  }
  return "views://mainview/index.html";
}

// --- Local portable database (DuckDB) ---
// CREEBA_DATA_DIR lets you run a 2nd local instance (otherwise DuckDB locks the
// file: a single writer per database).
const dataDir = process.env.CREEBA_DATA_DIR ?? join(homedir(), ".creeba-chat-electrobun");
mkdirSync(dataDir, { recursive: true });
const store = await ChatDB.open(join(dataDir, "chat.duckdb"));

// Local identity (persisted by the app); updated on a name change.
let identity: Identity = await store.getOrCreateIdentity();

// --- P2P sync (creeba: generic core + iroh/mDNS transport) ---
// The app defines its protocol/service and the app payload (Wire union).
const sync = new CreebaSync<Wire>({
  transport: new IrohMdnsTransport<Wire>({
    protocol: CHAT_PROTOCOL,
    serviceType: CHAT_SERVICE_TYPE,
  }),
  identity: { userId: identity.userId, metadata: { name: identity.name } },
  topic: DEFAULT_ROOM,
});

// Project a generic creeba peer (free metadata) onto the UI peer (name).
const toPeer = (p: CreebaPeer): Peer => ({
  peerId: p.peerId,
  userId: p.userId,
  name: typeof p.metadata?.name === "string" ? p.metadata.name : "?",
});

const genId = (): string => crypto.randomUUID();

// --- RPC main <-> webview ---
const rpc = BrowserView.defineRPC<ChatRPC>({
  handlers: {
    requests: {
      getState: async () => ({
        identity,
        peers: sync.peers().map(toPeer),
        messages: await store.recentMessages(DEFAULT_ROOM),
        status: sync.status(),
      }),
      setName: async ({ name }) => {
        identity = { ...identity, name };
        await store.setName(identity.userId, name);
        sync.setIdentity({ userId: identity.userId, metadata: { name } });
        return identity;
      },
      sendMessage: async ({ body }) => {
        const message: ChatMessage = {
          id: genId(),
          room: DEFAULT_ROOM,
          userId: identity.userId,
          name: identity.name,
          body,
          ts: Date.now(),
        };
        await store.insertMessage(message);
        sync.broadcast({ t: "msg", msg: message });
        return message;
      },
    },
  },
});

// Persist an incoming message + push it to the webview (the UI dedups by id).
const ingest = (message: ChatMessage): void => {
  void store.insertMessage(message).catch(() => {});
  rpc.send.message(message);
};

sync.on("data", (frame, from) => {
  switch (frame.t) {
    case "msg":
      ingest(frame.msg);
      break;
    case "sync-req":
      // A peer asks for what it missed → reply with our delta since its cursor.
      if (from)
        void store
          .messagesSince(DEFAULT_ROOM, frame.since)
          .then((items) => sync.send(from.peerId, { t: "sync-res", items }));
      break;
    case "sync-res":
      for (const msg of frame.items) ingest(msg);
      break;
  }
});

// Backfill: when a peer joins, pull the history we're missing from it. Both
// sides do this symmetrically; duplicates are dropped by the idempotent insert.
sync.on("peer", (peer) => {
  void store.latestTs(DEFAULT_ROOM).then((since) => sync.send(peer.peerId, { t: "sync-req", since }));
});

sync.on("peers", (peers) => rpc.send.peers(peers.map(toPeer)));
sync.on("status", (status) => rpc.send.status(status));

const url = await getMainViewUrl();
const mainWindow = new BrowserWindow({
  title: "Creeba Chat",
  url,
  rpc,
  frame: { width: 960, height: 720, x: 200, y: 200 },
});

const { publicKey } = await sync.start();
rpc.send.status(sync.status());

console.log(`Creeba Chat started — ${identity.name} (${publicKey.slice(0, 12)}…)`);

process.on("SIGINT", () => {
  sync.destroy();
  process.exit(0);
});

export { mainWindow };
