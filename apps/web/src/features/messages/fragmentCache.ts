export interface CachedFragment { data: ArrayBuffer; start: number; duration: number }

// Per-player RAM only: never CacheStorage, IndexedDB, service-worker caching or
// server storage. Keep copies because the transmux worker transfers its buffers.
export class FragmentCache {
  private entries = new Map<string, CachedFragment>();
  bytes = 0;
  hits = 0;
  constructor(readonly limit = 64 * 1024 * 1024) {}
  get(key: string): ArrayBuffer | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key); this.entries.set(key, entry); this.hits++;
    return entry.data.slice(0);
  }
  put(key: string, entry: CachedFragment): void {
    if (entry.data.byteLength > this.limit) return;
    const old = this.entries.get(key);
    if (old) { this.bytes -= old.data.byteLength; this.entries.delete(key); }
    while (this.bytes + entry.data.byteLength > this.limit) {
      const key = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(key)!.data.byteLength; this.entries.delete(key);
    }
    this.entries.set(key, { ...entry, data: entry.data.slice(0) });
    this.bytes += entry.data.byteLength;
  }
  ranges(): [number, number][] {
    return [...this.entries.values()].map(e => [e.start, e.start + e.duration]);
  }
  clear(): void { this.entries.clear(); this.bytes = 0; }
}
