/**
 * Lightweight data-oriented ECS.
 *  - Entities are plain numeric IDs.
 *  - Components are pure data, pooled per-store (destroyed components are
 *    recycled through a free-list so the update loop never allocates).
 *  - Systems are pure functions living elsewhere; the World only stores data.
 *
 * Iteration strategy: World keeps a dense `ids` array; systems loop over it
 * with Map.get() lookups — no Map iterators, no tuple allocations per frame.
 */

export class Store<T> {
  readonly m = new Map<number, T>();
  private free: T[] = [];
  private factory: () => T;

  constructor(factory: () => T) {
    this.factory = factory;
  }

  /** Attach a component to entity `e`. The init callback mutates a pooled object. */
  add(e: number, init: (c: T) => void): T {
    let c = this.free.pop();
    if (c === undefined) c = this.factory();
    init(c);
    this.m.set(e, c);
    return c;
  }

  get(e: number): T | undefined {
    return this.m.get(e);
  }

  has(e: number): boolean {
    return this.m.has(e);
  }

  /** Detach + recycle. */
  del(e: number): void {
    const c = this.m.get(e);
    if (c !== undefined) {
      this.m.delete(e);
      this.free.push(c);
    }
  }

  get size(): number {
    return this.m.size;
  }
}

export class World {
  private nextId = 1;
  /** Dense entity list for allocation-free iteration. */
  readonly ids: number[] = [];
  private index = new Map<number, number>();
  private stores: Store<unknown>[] = [];
  private storeByName = new Map<string, Store<unknown>>();
  /** Deferred destruction queue — entities die between system passes, never mid-iteration. */
  private graveyard: number[] = [];

  create(): number {
    const e = this.nextId++;
    this.index.set(e, this.ids.length);
    this.ids.push(e);
    return e;
  }

  queueDestroy(e: number): void {
    this.graveyard.push(e);
  }

  /** Flush deferred destroys. Call once per frame, after all systems ran. */
  flushDestroys(): void {
    while (this.graveyard.length > 0) {
      const e = this.graveyard.pop() as number;
      const i = this.index.get(e);
      if (i === undefined) continue;
      const last = this.ids.pop() as number;
      this.index.delete(e);
      if (last !== e) {
        this.ids[i] = last;
        this.index.set(last, i);
      }
      for (let s = 0; s < this.stores.length; s++) this.stores[s].del(e);
    }
  }

  /** Get (or lazily create) a typed component store by name. */
  s<T>(name: string, factory?: () => T): Store<T> {
    let store = this.storeByName.get(name);
    if (store === undefined) {
      const f: () => T = factory ?? ((): T => ({} as T));
      store = new Store<unknown>(f as () => unknown);
      this.storeByName.set(name, store);
      this.stores.push(store);
    }
    return store as Store<T>;
  }

  get count(): number {
    return this.ids.length;
  }

  reset(): void {
    this.ids.length = 0;
    this.index.clear();
    for (const s of this.stores) s.m.clear();
    this.graveyard.length = 0;
    this.nextId = 1;
  }
}
