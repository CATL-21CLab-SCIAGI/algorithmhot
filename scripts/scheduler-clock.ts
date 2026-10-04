// Beijing scheduling arithmetic only: no timers, network, database or environment access.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SIX_HOURS = 6 * HOUR;
export interface ScheduleClock { nextDailyAt: string; nextSourcesAt: string }
export interface ScheduledJob { kind: "daily" | "sources"; dueAt: string; date: string; id: string }
const milliseconds = (date: string | number | Date) => new Date(date).getTime();
export function beijingDay(date: string | number | Date): string {
  return new Date(milliseconds(date) + 8 * HOUR).toISOString().slice(0, 10);
}
export function nextDailyAt(now: string | number | Date): string {
  const t = milliseconds(now);
  const todayAtEight = Date.parse(`${beijingDay(t)}T00:00:00Z`);
  return new Date(todayAtEight > t ? todayAtEight : todayAtEight + DAY).toISOString();
}
/** On start, skip expired checkpoints rather than replaying missed batches. */
export function startClock(now: string | number | Date, previous?: ScheduleClock): ScheduleClock {
  const t = milliseconds(now);
  const source = previous ? Date.parse(previous.nextSourcesAt) : NaN;
  return { nextDailyAt: nextDailyAt(t), nextSourcesAt: new Date(Number.isFinite(source) && source > t ? source : t + SIX_HOURS).toISOString() };
}
/** Capture at most one due job of each kind; a collision is explicitly daily, then source check. */
export function takeDue(clock: ScheduleClock, now: string | number | Date): { clock: ScheduleClock; jobs: ScheduledJob[] } {
  const t = milliseconds(now);
  const next = { ...clock };
  const jobs: ScheduledJob[] = [];
  const daily = Date.parse(clock.nextDailyAt);
  if (daily <= t) {
    // A long suspended process never replays a sequence of old daily editions.
    const latestAtEight = Date.parse(`${beijingDay(t)}T00:00:00Z`);
    const due = latestAtEight <= t ? latestAtEight : latestAtEight - DAY;
    const date = beijingDay(due);
    jobs.push({ kind: "daily", dueAt: new Date(due).toISOString(), date, id: `daily-${date}` });
    next.nextDailyAt = nextDailyAt(t);
  }
  const source = Date.parse(clock.nextSourcesAt);
  if (source <= t) {
    const elapsed = Math.floor((t - source) / SIX_HOURS);
    const due = source + elapsed * SIX_HOURS;
    const dueAt = new Date(due).toISOString();
    jobs.push({ kind: "sources", dueAt, date: beijingDay(due), id: `sources-${dueAt.replace(/[^0-9]/g, "").slice(0, 14)}` });
    next.nextSourcesAt = new Date(due + SIX_HOURS).toISOString();
  }
  return { clock: next, jobs };
}
