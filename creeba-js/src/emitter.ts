/**
 * Minimal, dependency-free typed event emitter (no `node:events`), to stay
 * portable across Bun, Node and React Native/Hermes.
 */
export type Listener<Args extends unknown[]> = (...args: Args) => void;

export class Emitter<Events extends Record<string, unknown[]>> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, cb: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb as Listener<never>);
    return () => {
      set?.delete(cb as Listener<never>);
    };
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        (cb as Listener<Events[K]>)(...args);
      } catch {
        /* a throwing listener must not break the others */
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
