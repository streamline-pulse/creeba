/**
 * Chat app types — defined BY the app (creeba-js is generic and knows nothing
 * about messages). This is the payload carried over the `data` channel of
 * `CreebaSync`.
 */

/** A chat message (persisted locally + broadcast over P2P). */
export interface ChatMessage {
  id: string;
  room: string;
  userId: string;
  name: string;
  body: string;
  /** Epoch milliseconds. */
  ts: number;
}

/** Local user profile, as handled by the UI. */
export interface Profile {
  userId: string;
  name: string;
}

/** Chat protocol/ALPN and mDNS service — shared by all clients (desktop, mobile). */
export const CHAT_PROTOCOL = "creeba/chat/0";
export const CHAT_SERVICE_TYPE = "creebachat";
export const DEFAULT_ROOM = "creeba-chat";

/**
 * The P2P wire payload, sent as CreebaSync's opaque `data`. It MUST be identical
 * across every Creeba chat client (expo, electrobun, elysia) since they share the
 * same ALPN and interoperate on the LAN:
 *  - `msg`      : a live chat message;
 *  - `sync-req` : a joiner asks for history since a cursor (max ts it already has);
 *  - `sync-res` : the delta answer. Receivers dedup by message id.
 */
export type Wire =
  | { t: "msg"; msg: ChatMessage }
  | { t: "sync-req"; since: number }
  | { t: "sync-res"; items: ChatMessage[] };
