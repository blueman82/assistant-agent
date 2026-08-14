export interface Queue<T> {
  add(item: T): void;
  drain(): Promise<void>;
  clear(): void;
  readonly size: number;
}

export function createSingleFlightQueue<T>(worker: (item: T) => Promise<void>): Queue<T> {
  const items: T[] = [];
  let running = false;
  return {
    add(item) { items.push(item); void this.drain(); },
    async drain() {
      if (running) return;
      running = true;
      try { while (items.length) await worker(items.shift()!); }
      finally { running = false; }
    },
    clear() { items.length = 0; },
    get size() { return items.length; },
  };
}

