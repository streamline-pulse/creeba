import type { Identity, Peer } from "@streamline-pulse/creeba-core";
import type { Hlc, Op } from "@streamline-pulse/creeba-oplog";
import type { SignedMembership, TrustAnchors } from "./certs.ts";
import type { NodeCrypto } from "./crypto.ts";
import { PeerTrust, type TrustedPeer } from "./peers.ts";
import { mayAccept, mayServe } from "./scope.ts";
import {
  advance,
  isMissingFrom,
  vectorFrom,
  type VersionVector,
} from "./version_vector.ts";

/**
 * Wire messages of the mesh. `ops` carries operations, `pull` asks a peer for
 * what we are missing.
 *
 * `have` is a version vector — the highest HLC we hold PER ORIGIN NODE — so the
 * peer answers with the delta instead of its whole journal. `sinceHlc` predates
 * it and is kept for the wire: a peer running an older version reads that field
 * and ignores `have`, so both directions stay correct while a fleet updates.
 */
export type MeshMsg =
  | { t: "ops"; ops: Op[] }
  | { t: "pull"; sinceHlc: Hlc | null; have?: VersionVector };

function isMeshMsg(msg: unknown): msg is MeshMsg {
  const t = (msg as { t?: unknown } | null | undefined)?.t;
  return t === "ops" || t === "pull";
}

/** Where a peer's certificates travel: the presence metadata of the handshake. */
export const MEMBERSHIPS_KEY = "memberships";

/**
 * The journal, seen from the mesh. Deliberately narrow: the mesh reads and
 * applies operations, and knows nothing about how they are stored — Prisma,
 * SQLite, IndexedDB or memory are all the same to it.
 */
export interface MeshJournal {
  /** Awaited before serving or applying, if the store boots asynchronously. */
  ready?: Promise<unknown>;
  list(opts?: { sinceHlc?: Hlc }): Promise<Op[]>;
  /**
   * Apply a remote op. `false` = stale under LWW (already handled). THROWING
   * means "not applicable YET" (a missing dependency, e.g. a membership row
   * whose user has not arrived) — the mesh will retry it in a later pass.
   */
  apply(op: Op): Promise<boolean>;
}

/** The parts of `CreebaSync` the mesh uses. Any equivalent object works. */
export interface MeshPeerSync {
  send(peerId: string, msg: MeshMsg): void;
  peers(): Peer[];
  setIdentity(identity: Identity): void;
}

export interface MeshSyncOptions {
  sync: MeshPeerSync;
  journal: MeshJournal;
  /** Read at each evaluation — anchors change when we join or found an org. */
  anchors: () => TrustAnchors;
  myOrgIds: () => string[];
  isSuperPeer?: boolean;
  crypto?: NodeCrypto;
  /** Periodic catch-up. `null` disables it (tests, manual control). Default 20s. */
  catchUpIntervalMs?: number | null;
  /** How long `status().syncing` stays true after a pull. Default 4s. */
  pullWindowMs?: number;
  /** Retry passes for ops blocked by a missing dependency. Default 5. */
  applyPasses?: number;
  /**
   * Upper bound (serialized bytes) of one `ops` message served in reply to a
   * pull. A catch-up of a whole org can weigh tens of MB: a single message
   * above the transport frame limit is dropped, the peer is cut, and the same
   * reply is replayed forever. Default 1 MiB, well under any frame limit.
   */
  maxBatchBytes?: number;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * The mesh protocol: trust evaluation, org scoping, catch-up (pull/push) and
 * multi-hop gossip. It owns none of the plumbing — the app keeps its transport,
 * its journal and its own message types, and simply forwards the events.
 *
 *   const mesh = new MeshSync({ sync, journal, anchors, myOrgIds });
 *   sync.on("peer", (peer) => void mesh.onPeer(peer));
 *   sync.on("data", (msg, from) => void mesh.onData(msg, from));
 *
 * `onData` returns `false` for anything that is not a mesh message, so the app
 * can keep handling its own on the same channel.
 */
export class MeshSync {
  readonly trust: PeerTrust;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private catchUpTimer?: ReturnType<typeof setInterval>;
  private pullWindowTimer?: ReturnType<typeof setTimeout>;
  private lastSyncAt: number | null = null;
  private pulling = false;
  /** Ce que NOUS détenons, par nœud d'origine. Envoyé à chaque `pull`. */
  private have: VersionVector = {};
  private haveLoaded: Promise<void> | null = null;
  /**
   * Évaluations de confiance en cours. Vérifier une signature est asynchrone,
   * et une frame du pair peut doubler son propre `hello` : sans ça, elle serait
   * jetée pour « pair inconnu » alors qu'on est en train de l'admettre.
   */
  private readonly evaluating = new Map<string, Promise<void>>();

  constructor(private readonly options: MeshSyncOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = options.log ?? (() => {});
    this.trust = new PeerTrust({
      anchors: options.anchors,
      myOrgIds: options.myOrgIds,
      isSuperPeer: options.isSuperPeer,
      crypto: options.crypto,
      now: this.now,
    });
  }

  /** Start the periodic catch-up — a safety net for a missed live broadcast. */
  start(): void {
    void this.loadHave();
    const interval = this.options.catchUpIntervalMs;
    if (interval === null) return;
    this.stop();
    this.catchUpTimer = setInterval(() => this.pullFromPeers(), interval ?? 20_000);
  }

  /**
   * Rebuild the version vector from the journal — ONE full read, at startup.
   * After that it is maintained incrementally, so a catch-up never has to look
   * at the whole journal again.
   */
  private loadHave(): Promise<void> {
    if (!this.haveLoaded)
      this.haveLoaded = (async () => {
        await this.options.journal.ready;
        this.have = vectorFrom(await this.options.journal.list());
      })().catch(() => {
        /* journal indisponible : on repartira d'un vecteur vide (correct, juste
           moins économe) */
      });
    return this.haveLoaded;
  }

  stop(): void {
    if (this.catchUpTimer) clearInterval(this.catchUpTimer);
    if (this.pullWindowTimer) clearTimeout(this.pullWindowTimer);
    this.catchUpTimer = undefined;
    this.pullWindowTimer = undefined;
  }

  /**
   * Publish OUR certificates and re-evaluate the peers already known. The second
   * half matters as much as the first: those peers will not re-announce, but our
   * anchors just changed — we may now be able to trust someone we refused a
   * moment ago.
   */
  async announce(
    memberships: SignedMembership[],
    userId?: string,
  ): Promise<void> {
    this.options.sync.setIdentity({
      userId: userId ?? memberships[0]?.cert.userId ?? "",
      metadata: { [MEMBERSHIPS_KEY]: memberships },
    });
    await this.reevaluateKnownPeers();
    // NOS certificats ont changé : des pairs qui nous refusaient jusqu'ici vont
    // nous admettre. Notre confiance ENVERS eux, elle, n'a pas bougé — donc
    // aucun `pull` ne repartirait de lui-même, et nos demandes précédentes ont
    // été jetées. On redemande explicitement.
    this.pullFromPeers();
  }

  /** Re-run trust over every peer currently connected. */
  async reevaluateKnownPeers(): Promise<void> {
    await this.onPeers(this.options.sync.peers());
  }

  /**
   * Feed every `peers` event here — the full current list. Peers that have
   * DISAPPEARED are forgotten, which matters twice: we stop broadcasting into
   * the void, and a peer that comes back is treated as new, so reconnecting
   * triggers an immediate catch-up instead of waiting for the next tick.
   */
  async onPeers(peers: Peer[]): Promise<void> {
    const present = new Set(peers.map((p) => p.peerId));
    for (const known of this.trust.peers())
      if (!present.has(known.peerId)) this.trust.forget(known.peerId);
    for (const peer of peers) await this.onPeer(peer);
  }

  /** Feed every `peer` / `peers` event here. */
  async onPeer(peer: Peer): Promise<void> {
    // Une évaluation à la fois par pair : deux annonces rapprochées ne doivent
    // pas se croiser et conclure chacune de leur côté.
    const pending = this.evaluating.get(peer.peerId);
    if (pending) await pending;
    const run = this.evaluatePeer(peer);
    this.evaluating.set(peer.peerId, run);
    try {
      await run;
    } finally {
      if (this.evaluating.get(peer.peerId) === run)
        this.evaluating.delete(peer.peerId);
    }
  }

  private async evaluatePeer(peer: Peer): Promise<void> {
    const memberships =
      ((peer.metadata as Record<string, unknown> | undefined)?.[
        MEMBERSHIPS_KEY
      ] as SignedMembership[] | undefined) ?? [];

    const result = await this.trust.evaluate(peer.peerId, memberships);
    if (!result.ok) {
      // Silent on peers we never trusted and that bring nothing: on a shared
      // LAN, strangers announce themselves constantly.
      if (memberships.length > 0 && !this.trust.has(peer.peerId))
        this.log(`peer refused ${short(peer.peerId)} — ${result.reason}`);
      return;
    }
    if (!result.grew) return;

    this.log(
      `peer trusted ${short(peer.peerId)} (user=${result.peer.userId}, orgs=${result.peer.orgIds.length})`,
    );
    // Un seul message suffit. Notre `pull` nous rapporte ce qui nous manque, et
    // le SIEN — qu'il envoie en nous accordant sa confiance — lui rapporte ce
    // qui lui manque. Pousser en plus notre journal ferait doublon : au moment
    // où il nous a envoyé son `pull`, son vecteur ne connaissait pas encore ces
    // ops, donc on les lui renvoie de toute façon en réponse.
    await this.loadHave();
    this.options.sync.send(peer.peerId, {
      t: "pull",
      sinceHlc: null,
      have: { ...this.have },
    });
  }

  /** Feed every `data` event here. Returns `false` if it was not for the mesh. */
  async onData(msg: unknown, from: Peer): Promise<boolean> {
    if (!isMeshMsg(msg)) return false;
    let peer = this.trust.get(from.peerId);
    if (!peer) {
      // Peut-être une évaluation en cours que cette frame a doublée : on
      // l'attend plutôt que de jeter un message légitime. On n'attend QUE ce
      // qu'on avait déjà lancé — un inconnu n'obtient rien de plus.
      await this.evaluating.get(from.peerId);
      peer = this.trust.get(from.peerId);
    }
    // An untrusted peer gets nothing and gives nothing.
    if (!peer) return true;

    await this.options.journal.ready;

    if (msg.t === "pull") {
      const all = await this.options.journal.list(
        msg.sinceHlc ? { sinceHlc: msg.sinceHlc } : undefined,
      );
      // Ce que le demandeur n'a pas ET qui le concerne. Sans `have` (pair d'une
      // version antérieure), on lui sert tout, comme avant.
      const ops = all.filter(
        (op) => mayServe(op, peer) && isMissingFrom(op, msg.have),
      );
      for (const batch of batchBySize(ops, this.options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES))
        this.options.sync.send(from.peerId, { t: "ops", ops: batch });
      return true;
    }

    const applied = await this.applyOps(msg.ops, peer);
    if (applied.length) {
      this.lastSyncAt = Date.now();
      this.pulling = false;
      this.log(
        `${applied.length}/${msg.ops.length} op(s) applied from ${short(from.peerId)}`,
      );
      // Multi-hop gossip: relay what is fresh. HLC dedup stops the propagation,
      // so this terminates even on a cyclic mesh.
      for (const op of applied) this.broadcastOp(op, from.peerId);
    }
    return true;
  }

  /** Call for every op the app journals LOCALLY. */
  onLocalOp(op: Op): void {
    advance(this.have, op);
    this.broadcastOp(op);
  }

  /** Trigger an immediate catch-up (a "sync now" button). */
  pullNow(): { ok: boolean; peers: number } {
    const peers = this.trust.size;
    this.pullFromPeers();
    return { ok: peers > 0, peers };
  }

  peers(): TrustedPeer[] {
    return this.trust.peers();
  }

  peer(peerId: string): TrustedPeer | undefined {
    return this.trust.get(peerId);
  }

  status(): { trustedPeers: number; lastSyncAt: number | null; syncing: boolean } {
    return {
      trustedPeers: this.trust.size,
      lastSyncAt: this.lastSyncAt,
      syncing: this.pulling,
    };
  }

  /** Send an op to every trusted peer it concerns, except `exceptPeerId`. */
  private broadcastOp(op: Op, exceptPeerId?: string): void {
    for (const peer of this.trust.peers())
      if (peer.peerId !== exceptPeerId && mayServe(op, peer))
        this.options.sync.send(peer.peerId, { t: "ops", ops: [op] });
  }

  /**
   * Apply a batch in several passes. An op may fail because a dependency has
   * not landed yet (a membership row before its user); as long as a pass makes
   * progress, the rest is retried — so arrival ORDER stops mattering.
   *
   * `mayAccept` only checks that WE hold `op.orgId` — it says nothing about
   * whether the SENDER was entitled to it. A node that belongs to several orgs
   * could otherwise be used to inject an op into one of its orgs via a peer
   * only trusted for another. `mayServe(op, from)` is the same check used
   * before serving/broadcasting an op TO a peer; applied here, it also gates
   * what we accept FROM one, which is the missing half of the same rule.
   */
  private async applyOps(ops: Op[], from: TrustedPeer): Promise<Op[]> {
    const applied: Op[] = [];
    const isSuperPeer = this.options.isSuperPeer ?? false;
    const myOrgIds = this.options.myOrgIds();
    let pending = ops.filter(
      (op) => mayAccept(op, myOrgIds, isSuperPeer) && mayServe(op, from),
    );

    const passes = this.options.applyPasses ?? 5;
    for (let pass = 0; pass < passes && pending.length; pass++) {
      const failed: Op[] = [];
      for (const op of pending) {
        try {
          // `false` = stale under LWW, i.e. already handled — not a failure.
          if (await this.options.journal.apply(op)) applied.push(op);
          // Applied OR stale, we now hold it: the cursor moves either way. Only
          // an op that THREW stays missing, so it is asked for again.
          advance(this.have, op);
        } catch {
          failed.push(op);
        }
      }
      if (failed.length === pending.length) {
        // No progress at all: the dependencies are genuinely absent, retrying
        // would only spin.
        for (const op of failed)
          this.log(`op not applicable (missing dependency?): ${op.entity}`);
        break;
      }
      pending = failed;
    }
    return applied;
  }

  private pullFromPeers(): void {
    const peers = this.trust.peers();
    if (peers.length === 0) return;
    // "In progress" window: ops come back asynchronously, so we show it briefly
    // and close it early when they actually arrive (see onData).
    this.pulling = true;
    if (this.pullWindowTimer) clearTimeout(this.pullWindowTimer);
    this.pullWindowTimer = setTimeout(() => {
      this.pulling = false;
    }, this.options.pullWindowMs ?? 4_000);
    void this.loadHave().then(() => {
      for (const peer of peers)
        this.options.sync.send(peer.peerId, {
          t: "pull",
          sinceHlc: null,
          have: { ...this.have },
        });
    });
  }

  /** Ce que ce nœud détient, par origine (diagnostic / tests). */
  version(): VersionVector {
    return { ...this.have };
  }
}

function short(peerId: string): string {
  return `${peerId.slice(0, 12)}…`;
}


const DEFAULT_MAX_BATCH_BYTES = 1024 * 1024;

/**
 * Split ops into consecutive batches whose serialized size stays under `max`.
 * An op larger than `max` on its own still travels, alone in its batch: the
 * receiver applies batches independently, so partial delivery only delays the
 * rest of the catch-up instead of poisoning it.
 */
export function batchBySize<T>(ops: T[], max: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const op of ops) {
    const bytes = JSON.stringify(op).length + 1;
    if (current.length && size + bytes > max) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(op);
    size += bytes;
  }
  if (current.length) batches.push(current);
  return batches;
}
