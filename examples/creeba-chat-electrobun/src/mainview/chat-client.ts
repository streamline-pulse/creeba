import { Electroview } from "electrobun/view";
import type { ChatMessage, Identity, Peer } from "../shared/chat";
import type { ChatRPC } from "../shared/chat";

type StatusPayload = { ready: boolean; publicKey?: string };

type EventMap = {
  message: ChatMessage;
  peers: Peer[];
  status: StatusPayload;
};

const listeners: { [K in keyof EventMap]: Set<(payload: EventMap[K]) => void> } = {
  message: new Set(),
  peers: new Set(),
  status: new Set(),
};

function emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
  for (const cb of listeners[event]) cb(payload);
}

const rpc = Electroview.defineRPC<ChatRPC>({
  handlers: {
    messages: {
      message: (payload) => emit("message", payload),
      peers: (payload) => emit("peers", payload),
      status: (payload) => emit("status", payload),
    },
  },
});

new Electroview({ rpc });

export const chat = {
  on<K extends keyof EventMap>(event: K, cb: (payload: EventMap[K]) => void): () => void {
    listeners[event].add(cb);
    return () => listeners[event].delete(cb);
  },
  getState: () => rpc.request.getState(),
  setName: (name: string): Promise<Identity> => rpc.request.setName({ name }),
  sendMessage: (body: string): Promise<ChatMessage> => rpc.request.sendMessage({ body }),
};
