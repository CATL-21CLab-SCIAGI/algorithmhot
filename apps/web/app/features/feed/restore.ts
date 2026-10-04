// Return-position snapshots for list pages: loaded cards, expanded/collapsed state and the
// on-screen anchor (card key + offset), keyed by the history entry. Session-scoped, not a contract.

import { sessionCache } from "./session-cache";

const PREFIX = "aihot:list:";
const MAX_AGE_MS = 30 * 60 * 1000;

export interface ListSnapshot<T> {
  savedAt: number;
  data: T;
  anchor: { key: string; offset: number } | null;
  scrollY: number;
}

const snapshots = sessionCache<ListSnapshot<unknown>>(PREFIX, MAX_AGE_MS);

let hydrated = false;
export function markHydrated() {
  hydrated = true;
}
export function isHydrated() {
  return hydrated;
}

/**
 * True when this document was loaded by the reader's reload. A reload asks for the latest list (the
 * home page has no "new items" prompt), so it never restores a saved list; back and forward do.
 */
export function isReload(): boolean {
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return nav?.type === "reload";
  } catch {
    return false;
  }
}

export function saveSnapshot<T>(historyKey: string, data: T, anchorSelector = "[data-card-key]", flush = false) {
  try {
    let anchor: ListSnapshot<T>["anchor"] = null;
    const cards = document.querySelectorAll<HTMLElement>(anchorSelector);
    for (const el of cards) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > 72) {
        anchor = { key: el.dataset.cardKey!, offset: rect.top };
        break;
      }
    }
    const snap: ListSnapshot<T> = { savedAt: Date.now(), data, anchor, scrollY: window.scrollY };
    snapshots.set(historyKey, snap);
    if (flush) snapshots.flush();
  } catch {
    // storage unavailable: the list simply reloads from the first page
  }
}

export function readSnapshot<T>(historyKey: string): ListSnapshot<T> | null {
  return snapshots.read(historyKey) as ListSnapshot<T> | null;
}

/** Puts the anchor card back at the same viewport offset (falls back to the raw scroll position). */
export function restoreAnchor(anchor: ListSnapshot<unknown>["anchor"], scrollY: number) {
  const apply = () => {
    if (anchor) {
      const el = document.querySelector<HTMLElement>(`[data-card-key="${CSS.escape(anchor.key)}"]`);
      if (el) {
        const top = el.getBoundingClientRect().top + window.scrollY - anchor.offset;
        window.scrollTo({ top, behavior: "instant" as ScrollBehavior });
        return;
      }
    }
    window.scrollTo({ top: scrollY, behavior: "instant" as ScrollBehavior });
  };
  requestAnimationFrame(() => {
    apply();
    // Images or late layout may shift content; settle once more.
    setTimeout(apply, 120);
  });
}
