import { describe, expect, it } from "bun:test";
import {
  generateSecretKey,
  publicKeyOf,
  sign,
  verify,
} from "@streamline-pulse/creeba-iroh-mdns";
import { CompositeTransport, type WireFrame } from "@streamline-pulse/creeba-core";
import { WsClientTransport, WsServerTransport, type WsAttachment } from "./src/index.ts";

function waitFor<T>(fn: (resolve: (v: T) => void) => void, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    fn((v) => {
      clearTimeout(t);
      resolve(v);
    });
  });
}

describe("creeba-ws", () => {
  it("handshake + frames both ways + composite dedup", async () => {
    const serverKey = generateSecretKey();
    const clientKey = generateSecretKey();
    const serverId = publicKeyOf(serverKey);
    const clientId = publicKeyOf(clientKey);

    const server = new WsServerTransport({
      id: serverId,
      sign: (m) => sign(serverKey, m),
      verify,
    });
    server.join("room-1");

    const atts = new Map<unknown, WsAttachment>();
    const httpServer = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined as unknown as Response;
        return new Response("nope", { status: 400 });
      },
      websocket: {
        open(ws) {
          atts.set(ws, server.attach({ send: (d) => ws.send(d), close: () => ws.close() }));
        },
        message(ws, m) {
          atts.get(ws)?.onMessage(String(m));
        },
        close(ws) {
          atts.get(ws)?.onClose();
          atts.delete(ws);
        },
      },
    });

    const client = new WsClientTransport({
      url: `ws://localhost:${httpServer.port}`,
      id: clientId,
      sign: (m) => sign(clientKey, m),
      verify,
      expectedPeerId: serverId,
    });
    // Composite wrapping the client — checks pass-through + single logical peer.
    const composite = new CompositeTransport([client]);
    composite.join("room-1");

    const serverSeesPeer = waitFor<string>((res) => server.on("peer-open", res));
    const clientSeesPeer = waitFor<string>((res) => composite.on("peer-open", res));
    const startedId = await composite.start();
    expect(startedId).toBe(clientId);

    expect(await serverSeesPeer).toBe(clientId); // identité PROUVÉE, pas déclarée
    expect(await clientSeesPeer).toBe(serverId);

    // client -> server
    const gotOnServer = waitFor<WireFrame<unknown>>((res) =>
      server.on("frame", (_p, f) => res(f)),
    );
    composite.send(serverId, { kind: "data", payload: { n: 1 } });
    expect(((await gotOnServer) as { payload: { n: number } }).payload.n).toBe(1);

    // server -> client (broadcast)
    const gotOnClient = waitFor<WireFrame<unknown>>((res) =>
      composite.on("frame", (_p, f) => res(f)),
    );
    server.broadcast({ kind: "data", payload: { n: 2 } });
    expect(((await gotOnClient) as { payload: { n: number } }).payload.n).toBe(2);

    // Un client avec une MAUVAISE clé (id ≠ signature) doit être rejeté.
    const impostorKey = generateSecretKey();
    const impostor = new WsClientTransport({
      url: `ws://localhost:${httpServer.port}`,
      id: serverId, // usurpe l'id du serveur
      sign: (m) => sign(impostorKey, m), // ...mais ne possède pas sa clé
      verify,
    });
    let impostorAccepted = false;
    server.on("peer-open", (p) => {
      if (p === serverId) impostorAccepted = true;
    });
    await impostor.start();
    await new Promise((r) => setTimeout(r, 500));
    expect(impostorAccepted).toBe(false);

    impostor.destroy();
    composite.destroy();
    server.destroy();
    httpServer.stop(true);
  });
});
