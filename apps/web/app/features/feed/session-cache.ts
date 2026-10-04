// History-entry caches keep same-document returns synchronous. Writes are coalesced after interaction;
// hiding/leaving the document flushes them so a browser back/forward reload can restore the same data.
interface Timed { savedAt: number }
const MAX_MEMORY_ENTRIES = 20;

export function sessionCache<T extends Timed>(prefix: string, maxAge: number) {
  const memory = new Map<string, T>();
  const dirty = new Map<string, T>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listening = false;

  function flush() {
    clearTimeout(timer);
    timer = undefined;
    for (const [key, value] of dirty) {
      try { sessionStorage.setItem(prefix + key, JSON.stringify(value)); } catch { /* memory still works */ }
    }
    dirty.clear();
  }
  function remember(key: string, value: T) {
    memory.delete(key);
    memory.set(key, value);
    if (memory.size > MAX_MEMORY_ENTRIES) memory.delete(memory.keys().next().value!);
  }
  function peek(key: string): T | null {
    const value = memory.get(key) ?? dirty.get(key);
    if (!value) return null;
    if (Date.now() - value.savedAt <= maxAge) return value;
    memory.delete(key);
    dirty.delete(key);
    try { sessionStorage.removeItem(prefix + key); } catch { /* unavailable */ }
    return null;
  }
  function read(key: string): T | null {
    const hit = peek(key);
    if (hit) return hit;
    try {
      const raw = sessionStorage.getItem(prefix + key);
      if (!raw) return null;
      const value = JSON.parse(raw) as T;
      if (!value || !Number.isFinite(value.savedAt) || Date.now() - value.savedAt > maxAge) {
        sessionStorage.removeItem(prefix + key);
        return null;
      }
      remember(key, value);
      return value;
    } catch { return null; }
  }
  function set(key: string, value: T) {
    remember(key, value);
    dirty.set(key, value);
    if (!listening) {
      listening = true;
      window.addEventListener("pagehide", flush);
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
      // Expired history entries should not occupy the session storage quota indefinitely.
      try {
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
          const storedKey = sessionStorage.key(i);
          if (!storedKey?.startsWith(prefix)) continue;
          try {
            const old = JSON.parse(sessionStorage.getItem(storedKey)!);
            if (!old || !Number.isFinite(old.savedAt) || Date.now() - old.savedAt > maxAge) sessionStorage.removeItem(storedKey);
          } catch { sessionStorage.removeItem(storedKey); }
        }
      } catch { /* unavailable */ }
    }
    timer ??= setTimeout(flush, 50);
    // pagehide handlers may save a newer anchor after our flush handler has already run.
    if (document.visibilityState === "hidden") flush();
  }
  return { peek, read, set, flush };
}
