import { useEffect, useRef, useState } from "react";
import { CreebaSync } from "creeba-js";
import type { Peer, Status, SyncTransport } from "creeba-js";
import { SqliteStore } from "./store";
import { StubTransport } from "./transport";
import { DEFAULT_ROOM } from "./types";
import type { ChatMessage, Profile, Wire } from "./types";

/**
 * Pick the transport: native iroh (`creeba-expo`) when the native module is
 * linked (dev build / EAS), otherwise fall back to the stub (Expo Go, web) — the
 * app stays functional locally, without P2P.
 */
function createTransport(): SyncTransport<Wire> {
  try {
    // Lazy import: `requireNativeModule` throws if native is missing.
    // The native module fixes the ALPN/service (interop with desktop).
    const { IrohExpoTransport } = require("creeba-expo");
    return new IrohExpoTransport() as SyncTransport<Wire>;
  } catch {
    console.warn("[creeba-chat-expo] native iroh module unavailable — falling back to StubTransport (no P2P).");
    return new StubTransport();
  }
}

function genId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * React hook that mounts the Creeba sync layer on mobile: expo-sqlite store
 * (local) + transport (stub/native) + generic P2P core. The hook knows the
 * "chat" semantics (messages); creeba-js stays generic.
 */
export function useCreeba(room = DEFAULT_ROOM) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [status, setStatus] = useState<Status>({ ready: false });
  const syncRef = useRef<CreebaSync<Wire> | null>(null);
  const storeRef = useRef<SqliteStore | null>(null);
  const profileRef = useRef<Profile | null>(null);

  useEffect(() => {
    let disposed = false;
    const offs: Array<() => void> = [];
    let active: CreebaSync<Wire> | undefined;

    (async () => {
      const store = await SqliteStore.open();
      if (disposed) return;
      storeRef.current = store;

      const me = await store.getOrCreateIdentity();
      if (disposed) return;
      profileRef.current = me;
      setProfile(me);

      const sync = new CreebaSync<Wire>({
        transport: createTransport(),
        identity: { userId: me.userId, metadata: { name: me.name } },
        topic: room,
      });
      active = sync;
      syncRef.current = sync;

      // Persist an incoming message (idempotent) + add it to the UI (deduped by id).
      const addIncoming = (message: ChatMessage) => {
        void store.insertMessage(message).catch(() => {});
        setMessages((prev) => (prev.some((x) => x.id === message.id) ? prev : [...prev, message]));
      };

      offs.push(
        sync.on("data", (frame, from) => {
          switch (frame.t) {
            case "msg":
              addIncoming(frame.msg);
              break;
            case "sync-req":
              // A peer asks for what it missed → reply with our delta since its cursor.
              if (from)
                void store
                  .messagesSince(room, frame.since)
                  .then((items) => sync.send(from.peerId, { t: "sync-res", items }));
              break;
            case "sync-res":
              for (const msg of frame.items) addIncoming(msg);
              break;
          }
        }),
      );

      // Backfill: when a peer joins, pull the history we're missing from it.
      offs.push(
        sync.on("peer", (peer) => {
          void store.latestTs(room).then((since) => sync.send(peer.peerId, { t: "sync-req", since }));
        }),
      );
      offs.push(sync.on("peers", setPeers));
      offs.push(sync.on("status", setStatus));

      await sync.start();
      if (disposed) return;
      setStatus(sync.status());
      setMessages(await store.recentMessages(room));
    })();

    return () => {
      disposed = true;
      for (const off of offs) off();
      active?.destroy();
      syncRef.current = null;
      storeRef.current = null;
    };
  }, [room]);

  return {
    identity: profile,
    messages,
    peers,
    status,
    send: async (body: string) => {
      const sync = syncRef.current;
      const store = storeRef.current;
      const me = profileRef.current;
      if (!sync || !store || !me) return;
      const message: ChatMessage = {
        id: genId(),
        room,
        userId: me.userId,
        name: me.name,
        body,
        ts: Date.now(),
      };
      // Persist + local echo (peers receive it via the "data" event).
      await store.insertMessage(message);
      sync.broadcast({ t: "msg", msg: message });
      setMessages((prev) => (prev.some((x) => x.id === message.id) ? prev : [...prev, message]));
    },
    setName: (name: string) => {
      const sync = syncRef.current;
      const store = storeRef.current;
      const me = profileRef.current;
      if (!sync || !store || !me) return;
      const next: Profile = { ...me, name };
      profileRef.current = next;
      setProfile(next);
      void store.setName(me.userId, name);
      sync.setIdentity({ userId: next.userId, metadata: { name } });
    },
  };
}
