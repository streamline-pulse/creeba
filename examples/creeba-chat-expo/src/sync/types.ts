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
