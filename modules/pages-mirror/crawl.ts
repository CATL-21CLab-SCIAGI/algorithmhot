// Reads the running web service the way a visitor would and builds the mirror's files. A page or file
// that cannot be read is left out and counted; only an unreadable home page stops the run, so a broken
// site never replaces a working mirror with an empty one.
import { createHash } from "node:crypto";
import { cssRefs, ENTRY_PAGES, fallbackNotFound, htmlRefs, kindOf, outputFile, rewriteCss, rewriteHtml, rewriteManifest, proxiedImageKey, sourcePath, staticPath, stripScripts, type RewriteContext } from "./mirror.ts";

export interface CrawlOptions {
  /** The web service, as the worker reaches it: "http://web:3000". */
  origin: string;
  /** Pages (HTML and feeds) at most, entries first, then in the order their links were found. */
  maxPages: number;
  base: string;
  primary: string | null;
  siteName: string;
  timeoutMs?: number;
  concurrency?: number;
}

export interface CrawlResult {
  /** Output path (relative, "/"-separated) to contents. */
  files: Map<string, Buffer>;
  pages: number;
  assets: number;
  /** Paths that were wanted but could not be read. */
  skipped: string[];
}

/** An address a page names, as a same-origin path the mirror may take; null otherwise. */
function samePath(raw: string, origin: URL): string | null {
  let url: URL;
  try { url = new URL(raw, origin); } catch { return null; }
  if (url.origin !== origin.origin) return null;
  return staticPath(url.pathname, url.search);
}

/** Proxied images saved per run, at most. */
const MAX_IMAGES = 1000;

export async function crawl(options: CrawlOptions): Promise<CrawlResult> {
  const origin = new URL(options.origin);
  const timeoutMs = options.timeoutMs ?? 20_000;
  const concurrency = options.concurrency ?? 4;
  const pages = new Map<string, { body: Buffer; html: boolean }>();
  const assets = new Map<string, Buffer>();
  const skipped: string[] = [];

  const read = async (pathname: string): Promise<{ status: number; type: string; body: Buffer } | null> => {
    try {
      const res = await fetch(new URL(sourcePath(pathname), origin), { headers: { "user-agent": "pages-mirror", accept: "*/*" }, signal: AbortSignal.timeout(timeoutMs) });
      if (new URL(res.url).origin !== origin.origin) { await res.body?.cancel(); return null; }
      return { status: res.status, type: res.headers.get("content-type") ?? "", body: Buffer.from(await res.arrayBuffer()) };
    } catch {
      return null;
    }
  };

  /** Runs `work` over a growing queue, `concurrency` at a time, in queue order. */
  const drain = async (queue: string[], work: (pathname: string) => Promise<void>) => {
    for (let i = 0; i < queue.length;) {
      const batch = queue.slice(i, i + concurrency);
      i += batch.length;
      await Promise.all(batch.map(work));
    }
  };

  /** Proxied images the pages show, by what they show, to one address that serves it. */
  const imageRefs = new Map<string, string>();
  const pageQueue: string[] = [];
  const assetQueue: string[] = [];
  const queued = new Set<string>();
  const enqueue = (pathname: string) => {
    if (queued.has(pathname)) return;
    const kind = kindOf(pathname);
    if (kind === "page" && pageQueue.length < options.maxPages) pageQueue.push(pathname);
    else if (kind === "asset") assetQueue.push(pathname);
    else return;
    queued.add(pathname);
  };
  for (const entry of ENTRY_PAGES) enqueue(entry);

  await drain(pageQueue, async (pathname) => {
    const got = await read(pathname);
    if (!got || got.status !== 200) { skipped.push(pathname); return; }
    const html = /text\/html/i.test(got.type);
    pages.set(pathname, { body: got.body, html });
    if (!html) return;
    for (const ref of htmlRefs(stripScripts(got.body.toString("utf8")))) {
      const key = proxiedImageKey(ref);
      if (key) {
        if (!imageRefs.has(key) && imageRefs.size < MAX_IMAGES) imageRefs.set(key, ref);
        continue;
      }
      const target = samePath(ref, origin);
      if (target) enqueue(target);
    }
  });
  if (!pages.get("/")?.html) throw new Error(`the home page could not be read from ${origin.origin}`);

  await drain(assetQueue, async (pathname) => {
    const got = await read(pathname);
    if (!got || got.status !== 200) { skipped.push(pathname); return; }
    assets.set(pathname, got.body);
    if (/text\/css/i.test(got.type) || pathname.endsWith(".css")) {
      for (const ref of cssRefs(got.body.toString("utf8"), pathname)) enqueue(ref);
    }
  });

  // Each proxied image once, under a name that stays the same from run to run (no new files every day).
  const images = new Map<string, string>();
  await drain([...imageRefs.keys()], async (key) => {
    const got = await read(imageRefs.get(key)!);
    if (!got || got.status !== 200 || !/^image\//i.test(got.type)) { skipped.push(`image ${key.split("|")[0]}`); return; }
    const ext = /png/i.test(got.type) ? "png" : /jpe?g/i.test(got.type) ? "jpg" : /gif/i.test(got.type) ? "gif" : /svg/i.test(got.type) ? "svg" : "webp";
    const file = `/img/${createHash("sha256").update(key).digest("hex").slice(0, 24)}.${ext}`;
    images.set(key, file);
    assets.set(file, got.body);
  });

  const ctx: RewriteContext = {
    base: options.base,
    primary: options.primary,
    mirrored: new Set([...pages.keys(), ...assets.keys()]),
    siteName: options.siteName,
    images,
  };
  const files = new Map<string, Buffer>();
  for (const [pathname, page] of pages) {
    files.set(outputFile(pathname), page.html ? Buffer.from(rewriteHtml(page.body.toString("utf8"), ctx)) : page.body);
  }
  for (const [pathname, body] of assets) {
    const text = pathname.endsWith(".css") ? rewriteCss(body.toString("utf8"), ctx) : pathname.endsWith(".webmanifest") ? rewriteManifest(body.toString("utf8"), ctx) : null;
    files.set(outputFile(pathname), text === null ? body : Buffer.from(text));
  }
  // The site's own not-found page; GitHub Pages serves 404.html for any missing address.
  const missing = await read("/__pages-mirror-not-found");
  const notFound = missing?.status === 404 && /text\/html/i.test(missing.type) ? missing.body.toString("utf8") : fallbackNotFound(options.siteName);
  files.set("404.html", Buffer.from(rewriteHtml(notFound, ctx)));
  files.set(".nojekyll", Buffer.alloc(0));
  return { files, pages: pages.size, assets: assets.size, skipped };
}
