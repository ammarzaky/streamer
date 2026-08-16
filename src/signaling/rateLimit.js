export class TokenBucket {
  constructor({ capacity, refillPerSec }, now = Date.now()) { this.capacity = capacity; this.tokens = capacity; this.refillPerMs = refillPerSec / 1000; this.updatedAt = now; }
  take(now = Date.now(), count = 1) { this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, now - this.updatedAt) * this.refillPerMs); this.updatedAt = now; if (this.tokens < count) return false; this.tokens -= count; return true; }
}

export function createRateLimiter(config) {
  const buckets = new Map();
  return { take(key, kind, now = Date.now()) { let pair = buckets.get(key); if (!pair) { pair = { control: new TokenBucket(config.control, now), signal: new TokenBucket(config.signal, now), strikes: [] }; buckets.set(key, pair); } const ok = pair[kind].take(now); if (!ok) pair.strikes = pair.strikes.filter((t) => now - t <= config.strikeWindowMs).concat(now); return { ok, disconnect: !ok && pair.strikes.length >= config.strikesBeforeDisconnect }; }, delete(key) { buckets.delete(key); } };
}
