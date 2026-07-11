import { useEffect, useMemo, useRef, useState } from "react";
import { chat } from "./chat-client";
import type { ChatMessage, Identity, Peer } from "../shared/chat";

function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<{ ready: boolean; publicKey?: string }>({
    ready: false,
  });
  const [draft, setDraft] = useState("");
  const [editingName, setEditingName] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chat.getState().then((state) => {
      setIdentity(state.identity);
      setEditingName(state.identity.name);
      setPeers(state.peers);
      setMessages(state.messages);
      setStatus(state.status);
    });
    const offMsg = chat.on("message", (m) =>
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]))
    );
    const offPeers = chat.on("peers", setPeers);
    const offStatus = chat.on("status", setStatus);
    return () => {
      offMsg();
      offPeers();
      offStatus();
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    const message = await chat.sendMessage(body);
    setMessages((prev) => [...prev, message]);
  };

  const saveName = async () => {
    const name = editingName.trim();
    if (!name || name === identity?.name) return;
    const updated = await chat.setName(name);
    setIdentity(updated);
  };

  const onlineCount = useMemo(() => peers.length, [peers]);

  return (
    <div className="flex h-screen bg-slate-100 text-slate-900">
      {/* Users sidebar */}
      <aside className="w-64 shrink-0 bg-slate-900 text-slate-100 flex flex-col">
        <div className="p-4 border-b border-white/10">
          <div className="text-xs uppercase tracking-wide text-slate-400">Me</div>
          <div className="mt-1 flex gap-2">
            <input
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => e.key === "Enter" && saveName()}
              className="flex-1 bg-slate-800 rounded px-2 py-1 text-sm outline-none focus:ring-2 ring-indigo-500"
              placeholder="Your name"
            />
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-400">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                status.ready ? "bg-emerald-400" : "bg-amber-400"
              }`}
            />
            {status.ready ? "connected to P2P network" : "connecting…"}
          </div>
        </div>
        <div className="px-4 py-3 text-xs uppercase tracking-wide text-slate-400">
          Online · {onlineCount}
        </div>
        <ul className="flex-1 overflow-y-auto px-2 space-y-1">
          {peers.length === 0 && (
            <li className="px-2 py-1 text-sm text-slate-500">No peers yet…</li>
          )}
          {peers.map((peer) => (
            <li
              key={peer.peerId}
              className="px-2 py-1.5 rounded hover:bg-white/5 flex items-center gap-2"
            >
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
              <span className="text-sm truncate">{peer.name}</span>
            </li>
          ))}
        </ul>
      </aside>

      {/* Chat area */}
      <main className="flex-1 flex flex-col">
        <header className="px-6 py-4 bg-white border-b border-slate-200 shadow-sm">
          <h1 className="text-lg font-semibold">#{"creeba-chat"}</h1>
          <p className="text-xs text-slate-500">
            Encrypted P2P chat · local DuckDB · iroh + mDNS
          </p>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {messages.map((m) => {
            const mine = m.userId === identity?.userId;
            return (
              <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-lg rounded-2xl px-4 py-2 shadow-sm ${
                    mine ? "bg-indigo-600 text-white" : "bg-white text-slate-900"
                  }`}
                >
                  {!mine && (
                    <div className="text-xs font-medium text-indigo-500 mb-0.5">{m.name}</div>
                  )}
                  <div className="whitespace-pre-wrap break-words">{m.body}</div>
                  <div
                    className={`text-[10px] mt-1 ${mine ? "text-white/70" : "text-slate-400"}`}
                  >
                    {new Date(m.ts).toLocaleTimeString()}
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        <div className="px-6 py-4 bg-white border-t border-slate-200">
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="Write a message…"
              className="flex-1 rounded-lg border border-slate-300 px-4 py-2 outline-none focus:ring-2 ring-indigo-500"
            />
            <button
              onClick={send}
              className="px-5 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 transition-colors"
            >
              Send
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
