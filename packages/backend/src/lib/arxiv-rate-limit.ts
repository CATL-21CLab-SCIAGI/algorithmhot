import { sql } from "../db.ts";

const INTERVAL_MS = 3100;
const KEY = "fetch.arxiv.startedAt";
interface RateState {
  lastStartedAt: number | null;
  markStarted(at: number): Promise<void>;
}
type Exclusive = <T>(operation: (state: RateState) => Promise<T>) => Promise<T>;

export function isArxivRequest(url: string): boolean {
  try { return /^(?:rss\.|export\.|www\.)?arxiv\.org$/i.test(new URL(url).hostname); }
  catch { return false; }
}

/** One request at a time, with 3.1 s between starts; a slow request already satisfies the gap. */
export function createArxivRequestLimiter(exclusive: Exclusive, clock: { now(): number; sleep(ms: number): Promise<void> } = {
  now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  let tail = Promise.resolve();
  return async function limited<T>(url: string, operation: () => Promise<T>): Promise<T> {
    if (!isArxivRequest(url)) return operation();
    const request = tail.then(() => exclusive(async state => {
      const wait = state.lastStartedAt === null ? 0 : Math.max(0, INTERVAL_MS - (clock.now() - state.lastStartedAt));
      if (wait) await clock.sleep(wait);
      await state.markStarted(clock.now());
      return operation();
    }));
    tail = request.then(() => {}, () => {});
    return request;
  };
}

/** A session lock shares the gate with the scheduler/worker/CLI. Persist before HTTP so even a
 * failed request or a crashed process cannot roll back its start time and trigger an early retry. */
async function databaseGate<T>(operation: (state: RateState) => Promise<T>): Promise<T> {
  const db = await sql.reserve();
  let locked = false;
  try {
    await db`SELECT pg_advisory_lock(hashtext(${KEY}))`;
    locked = true;
    const [row] = await db<{ started: number | null }[]>`SELECT (value->>'startedAt')::double precision AS started FROM settings WHERE key=${KEY}`;
    return await operation({
      lastStartedAt: row?.started ?? null,
      markStarted: async at => {
        await db`INSERT INTO settings(key,value,updated_by) VALUES(${KEY},${db.json({ startedAt: at })},'arxiv-fetch')
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=clock_timestamp()`;
      },
    });
  } finally {
    try { if (locked) await db`SELECT pg_advisory_unlock(hashtext(${KEY}))`; }
    finally { db.release(); }
  }
}

export const withArxivRateLimit = createArxivRequestLimiter(databaseGate);
