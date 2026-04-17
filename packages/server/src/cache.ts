interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

const DEFAULT_TTL = 60_000; // 1 minute

export function cached<T>(
  key: string,
  fn: () => Promise<T>,
  ttl = DEFAULT_TTL,
): Promise<T> {
  const entry = store.get(key) as CacheEntry<T> | undefined;
  if (entry && entry.expiresAt > Date.now()) {
    return Promise.resolve(entry.data);
  }

  return fn().then((data) => {
    store.set(key, { data, expiresAt: Date.now() + ttl });
    return data;
  });
}

export function invalidate(key: string) {
  store.delete(key);
}

export function invalidatePrefix(prefix: string) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}
