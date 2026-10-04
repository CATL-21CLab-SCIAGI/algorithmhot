// Hugging Face dataset access: parquet files read at a pinned revision (hyparquet, pure JS), with the
// datasets-server JSON API as a fallback. From the server, huggingface.co goes through the egress proxy.
import { parquetReadObjects } from "hyparquet";
import { guardedFetch } from "../../lib/http-fetch.ts";

export async function hfParquetRows<T>(dataset: string, revision: string, file: string): Promise<T[]> {
  const res = await guardedFetch(`https://huggingface.co/datasets/${dataset}/resolve/${revision}/${file}`, { timeoutMs: 120_000, maxBytes: 64 * 1024 * 1024, maxRedirects: 5 });
  if (res.status !== 200) throw new Error(`${dataset}/${file} HTTP ${res.status}`);
  const buf = res.body;
  // HTTP bodies larger than Node's small-buffer pool already own the complete backing buffer.
  // Reuse that allocation; pooled/subarray bodies still need their exact byte range copied.
  const fileBuffer = buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
    ? buf.buffer as ArrayBuffer
    : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const rows = await parquetReadObjects({ file: fileBuffer });
  // int64 columns arrive as BigInt; the values involved (ranks, counts) fit in a number.
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v]))) as T[];
}

export async function hfDatasetSha(dataset: string): Promise<string | null> {
  const res = await guardedFetch(`https://huggingface.co/api/datasets/${dataset}`, { timeoutMs: 30_000 });
  if (res.status !== 200) return null;
  return (JSON.parse(res.text()) as { sha?: string }).sha ?? null;
}

/** All rows of a config/split matching an equality filter, 100 per request. */
export async function hfFilterRows<T>(dataset: string, config: string, split: string, where: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < 20_000; offset += 100) {
    const url = `https://datasets-server.huggingface.co/filter?${new URLSearchParams({ dataset, config, split, where, offset: String(offset), length: "100" })}`;
    const res = await guardedFetch(url, { timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024 });
    if (res.status !== 200) throw new Error(`datasets-server ${config}/${split} HTTP ${res.status}: ${res.text().slice(0, 200)}`);
    const body = JSON.parse(res.text()) as { rows: Array<{ row: T }>; num_rows_total: number };
    out.push(...body.rows.map((r) => r.row));
    if (out.length >= body.num_rows_total || !body.rows.length) break;
  }
  return out;
}
