/**
 * Chat app types + RPC schema, shared between the Bun (main) process and the
 * React webview.
 *
 * creeba-js is a GENERIC P2P layer (presence + opaque payloads): the notion of a
 * "chat message" and the displayed identity (name) are defined HERE, by the app.
 */

/** A chat message (payload carried over CreebaSync's `data` channel). */
export interface ChatMessage {
  id: string;
  room: string;
  userId: string;
  name: string;
  body: string;
  /** Epoch milliseconds. */
  ts: number;
}

/** Local profile displayed in the UI. */
export interface Identity {
  userId: string;
  name: string;
}

/** A connected peer, as displayed in the UI. */
export interface Peer {
  peerId: string;
  userId: string;
  name: string;
}

/** P2P node state. */
export interface Status {
  ready: boolean;
  publicKey?: string;
}

/** Default chat room (P2P topic). */
export const DEFAULT_ROOM = "creeba-chat";
/** Chat protocol/ALPN and mDNS service — common to all clients (desktop ↔ mobile interop). */
export const CHAT_PROTOCOL = "creeba/chat/0";
export const CHAT_SERVICE_TYPE = "creebachat";

/**
 * Electrobun RPC schema.
 * - `bun.requests`     : called by the webview, handled by main.
 * - `webview.messages` : pushed from main to the webview (fire-and-forget).
 */
export interface ChatRPC {
  bun: {
    requests: {
      getState: {
        params: void;
        response: { identity: Identity; peers: Peer[]; messages: ChatMessage[]; status: Status };
      };
      setName: { params: { name: string }; response: Identity };
      sendMessage: { params: { body: string }; response: ChatMessage };
    };
    messages: Record<never, never>;
  };
  webview: {
    requests: Record<never, never>;
    messages: {
      message: ChatMessage;
      peers: Peer[];
      status: Status;
    };
  };
}
