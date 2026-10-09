import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import { isValidDate } from "@aihot/contracts/time";

/** Calendar partitions of [start, end), using the UTC dates returned by HF. */
export function researchUtcDays(start: Date, end: Date): string[] {
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new Error("invalid research window");
  const dates: string[] = [];
  for (let day = Date.parse(`${start.toISOString().slice(0, 10)}T00:00:00Z`); day < end.getTime(); day += 86400000) dates.push(new Date(day).toISOString().slice(0, 10));
  return dates;
}

export function hfPageDecision(input: { page: number; returned: number; hasNext: boolean; repeated: boolean; maxPages?: number }): { stop: boolean; truncated: boolean } {
  if (input.returned === 0) return { stop: true, truncated: false };
  const truncated = input.repeated || (input.hasNext && input.page >= (input.maxPages ?? 10) - 1);
  return { stop: truncated || !input.hasNext, truncated };
}

/** Only HF's explicit date upper bound means an unopened signal date, never an empty result. */
export function hfDateNotYetAvailable(input: { status: number; url: string; body: string; observedAt: Date }): boolean {
  if (input.status !== 400 || !Number.isFinite(input.observedAt.getTime())) return false;
  try {
    const url = new URL(input.url), requested = url.searchParams.get("date") ?? "";
    if (url.origin !== "https://huggingface.co" || url.pathname !== "/api/daily_papers" || url.username || url.password
      || url.searchParams.getAll("date").length !== 1 || !isValidDate(requested)) return false;
    const message = JSON.parse(input.body)?.error;
    if (typeof message !== "string") return false;
    const match = /^✖ "date" must be less than or equal to "(\d{4}-\d{2}-\d{2})T00:00:00\.000Z"\n  → at date$/.exec(message);
    if (!match || !isValidDate(match[1]!)) return false;
    // A bad future-date request is a configuration error. Partition and observation use UTC.
    return match[1]! < requested && requested <= input.observedAt.toISOString().slice(0, 10);
  } catch { return false; }
}

export function responseRecordCount(text: string, kind: "json_list" | "rss"): number {
  const document = kind === "json_list" ? JSON.parse(text) : new XMLParser().parse(text);
  if (kind === "json_list" && !Array.isArray(document)) throw new Error("research JSON response is not an array");
  const entries = kind === "json_list" ? document : document.feed?.entry ?? document.rss?.channel?.item;
  return Array.isArray(entries) ? entries.length : entries ? 1 : 0;
}

/** Reserved in the database before fetching, so interruption cannot reuse an existing file name. */
export function researchResponsePath(folder: string, label: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error("invalid response label");
  return path.join(folder, `${label}-${randomUUID()}.body`);
}

export async function saveResearchResponse(file: string, body: Uint8Array, metadata: Record<string, unknown>): Promise<string> {
  const hash = createHash("sha256").update(body).digest("hex");
  await writeFile(file, body, { mode: 0o600, flag: "wx" });
  await writeFile(`${file}.json`, JSON.stringify({ ...metadata, sha256: hash, bytes: body.length }, null, 2), { mode: 0o600, flag: "wx" });
  return hash;
}

/** Frozen admissions permit an explicitly named HF signal date repair, never general re-import. */
export function researchReparseMode(frozen: boolean, sourceKind: string | undefined, explicitSource: boolean, linksOnly = false): "all" | "hf_metadata" | "links_only" {
  if (linksOnly) return "links_only";
  if (!frozen) return "all";
  if (explicitSource && sourceKind === "huggingface") return "hf_metadata";
  throw new Error("Frozen research batches permit only an explicitly specified HF metadata repair");
}
