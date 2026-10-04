import { originalLink } from "./original-link.ts";

interface BookmarkSource { id: string; originalUrl?: string }
interface ResolveOptions {
  items: BookmarkSource[];
  attempted: Set<string>;
  signal: AbortSignal;
  onAvailability(value: Record<string, string>): void;
  onOriginal(id: string, url: string): void;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** Resolve old bookmark sources at most once per page visit, including failed requests. */
export async function loadBookmarkOriginals({ items, attempted, signal, onAvailability, onOriginal, fetcher = fetch }: ResolveOptions): Promise<void> {
  const response = await fetcher(`/api/site/items/availability?ids=${encodeURIComponent(items.map(item => item.id).join(","))}`, { signal });
  // An unavailable service must not fan out into one detail request per bookmark.
  if (!response.ok || signal.aborted) return;
  const availability = await response.json() as Record<string, string>;
  if (signal.aborted) return;
  onAvailability(availability);
  const missing = items.filter(item => !originalLink(item.originalUrl) && availability[item.id] !== "unavailable" && !attempted.has(item.id));
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
    while (!signal.aborted) {
      const item = missing[cursor++];
      if (!item) return;
      if (attempted.has(item.id)) continue;
      attempted.add(item.id);
      try {
        const detailResponse = await fetcher(`/api/site/items/${encodeURIComponent(item.id)}`, { signal });
        if (!detailResponse.ok) continue;
        const detail = await detailResponse.json() as { id?: string; links?: { original?: string } };
        const url = detail.id === item.id ? originalLink(detail.links?.original) : null;
        if (url && !signal.aborted) onOriginal(item.id, url);
      } catch { /* Keep this attempt held for this visit; reopening the page can try again. */ }
    }
  }));
}
