// What the mirror takes from the site and how a page is rewritten for static hosting under a base path:
// plain server-rendered HTML without scripts, every root-relative address under the base, and links to
// what the mirror does not have sent to the full site.

/** Where the crawl starts, in this order. */
export const ENTRY_PAGES = [
  "/", "/all", "/hot", "/daily", "/daily/archive", "/weekly", "/monthly", "/topics", "/about", "/agent", "/terms", "/privacy",
  "/feed.xml", "/feed/daily.xml",
];

/**
 * Filtered views get addresses of their own, since a static host ignores the query: the category tabs of
 * 精选 and 全部 ("/?category=algorithm" is published at "/c/algorithm/"). Other queries (tags, unread)
 * are left to the full site.
 */
const FILTERABLE = new Set(["/", "/all"]);
const FILTERED = /^(\/all)?\/c\/([a-z0-9-]{1,40})$/;

/** The mirror's address for a page and its query; null when the mirror cannot publish that view. */
export function staticPath(pathname: string, search: string): string | null {
  if (!search || search === "?") return pathname;
  const params = new URLSearchParams(search);
  const keys = [...params.keys()];
  const category = params.get("category");
  if (!FILTERABLE.has(pathname) || keys.length !== 1 || keys[0] !== "category" || !category || !/^[a-z0-9-]{1,40}$/.test(category)) return null;
  return `${pathname === "/" ? "" : pathname}/c/${category}`;
}

/** The site's address for a mirror address (the reverse of staticPath). */
export function sourcePath(pathname: string): string {
  const m = FILTERED.exec(pathname);
  return m ? `${m[1] ?? "/"}?category=${m[2]}` : pathname;
}

/** Pages the crawl follows links to, besides the entries. */
const FOLLOWED = [FILTERED, /^\/daily\/[^/]+$/, /^\/weekly\/[^/]+$/, /^\/monthly\/[^/]+$/, /^\/items\/[^/]+$/, /^\/topics\/[^/]+$/, /^\/story\/[^/]+$/];

/** Files at the site's root the pages name (icons, the web manifest). */
const ROOT_FILE = /^\/[^/]+\.(?:ico|png|svg|jpe?g|webp|webmanifest)$/i;

export type Kind = "page" | "asset";

/** What a same-origin path is to the mirror; null for what it leaves to the full site. */
export function kindOf(pathname: string): Kind | null {
  if (pathname.startsWith("/api/") || pathname === "/api" || pathname === "/admin" || pathname.startsWith("/admin/")) return null;
  if (!safePath(pathname)) return null;
  if (ENTRY_PAGES.includes(pathname) || FOLLOWED.some((p) => p.test(pathname))) return "page";
  if (pathname.startsWith("/assets/") || ROOT_FILE.test(pathname)) return "asset";
  return null;
}

function safePath(pathname: string): boolean {
  if (/%2f|%5c|%00/i.test(pathname)) return false;
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  return decoded.split("/").every((part) => part !== "." && part !== ".." && !/[\0\\]/.test(part));
}

/** A page's or file's place in the output: "/" is index.html, "/x/y" is x/y/index.html, files keep their name. */
export function outputFile(pathname: string): string {
  const decoded = decodeURIComponent(pathname);
  if (decoded === "/") return "index.html";
  return /\.[a-z0-9]+$/i.test(decoded) ? decoded.slice(1) : `${decoded.slice(1)}/index.html`;
}

/** A root-relative address as the mirror publishes it: pages end in "/" so Pages need not redirect. */
function mirroredHref(base: string, pathname: string): string {
  if (pathname === "/") return `${base}/`;
  return /\.[a-z0-9]+$/i.test(pathname) ? `${base}${pathname}` : `${base}${pathname}/`;
}

export function normalizeBase(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  return trimmed === "" ? "" : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** An image the site serves through its proxy, by what it shows (the address carries a daily signature). */
export function proxiedImageKey(raw: string): string | null {
  const parts = rootRelative(raw);
  if (!parts || parts.pathname !== "/api/img-proxy") return null;
  const q = new URLSearchParams(parts.search);
  const u = q.get("u");
  return u ? `${u}|${q.get("mode") ?? ""}` : null;
}

export interface RewriteContext {
  /** Base path without a trailing slash ("/algorithmhot", or "" at the root). */
  base: string;
  /** The full site, for what the mirror does not have; without it those addresses stay under the base. */
  primary: string | null;
  /** Paths the mirror publishes (pages and files). */
  mirrored: ReadonlySet<string>;
  /** The site's name in the banner. */
  siteName: string;
  /** Proxied images the mirror saved, by proxiedImageKey, to their published path. */
  images?: ReadonlyMap<string, string>;
}

const decodeAttr = (value: string) => value.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');
const encodeAttr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const escapeText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A root-relative address split into path, query and fragment; null for anything else. */
function rootRelative(raw: string): { pathname: string; search: string; hash: string } | null {
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  const url = new URL(raw, "http://mirror.invalid");
  return { pathname: url.pathname, search: url.search, hash: url.hash };
}

/**
 * The address a root-relative one becomes; null drops it (images through the api's proxy, and without a
 * full site, links to filtered views the mirror does not publish). `link` is for href and form actions,
 * which go to the full site when the mirror does not have the target.
 */
export function mapUrl(raw: string, ctx: RewriteContext, link: boolean): string | null {
  const parts = rootRelative(raw);
  if (!parts) return raw;
  const { pathname, search, hash } = parts;
  if (!link && (pathname === "/api" || pathname.startsWith("/api/"))) {
    const saved = ctx.images?.get(proxiedImageKey(raw) ?? "");
    return saved ? `${ctx.base}${saved}` : null;
  }
  const published = staticPath(pathname, search);
  if (published && ctx.mirrored.has(published)) return mirroredHref(ctx.base, published) + hash;
  if (link && ctx.primary) return ctx.primary + raw;
  // A filter the mirror has no page for would show the unfiltered page: the link is dropped instead.
  if (link && search) return null;
  return ctx.base + raw;
}

function mapSrcset(value: string, ctx: RewriteContext): string | null {
  const kept = value.split(",").map((s) => s.trim()).filter(Boolean).flatMap((candidate) => {
    const [url, ...descriptor] = candidate.split(/\s+/);
    const mapped = mapUrl(url!, ctx, false);
    return mapped === null ? [] : [[mapped, ...descriptor].join(" ")];
  });
  return kept.length ? kept.join(", ") : null;
}

const CSS_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/g;
const CSS_IMPORT = /@import\s+(['"])([^'"]+)\1/g;

/** Root-relative url() and @import in a stylesheet go under the base; relative ones already work. */
export function rewriteCss(css: string, ctx: RewriteContext): string {
  const map = (raw: string) => mapUrl(raw, ctx, false) ?? "about:invalid";
  return css
    .replace(CSS_URL, (whole, quote: string, raw: string) => (rootRelative(raw) ? `url(${quote}${map(raw)}${quote})` : whole))
    .replace(CSS_IMPORT, (whole, quote: string, raw: string) => (rootRelative(raw) ? `@import ${quote}${map(raw)}${quote}` : whole));
}

/** Addresses a stylesheet names, resolved against its own path. */
export function cssRefs(css: string, fromPath: string): string[] {
  const refs: string[] = [];
  for (const re of [CSS_URL, CSS_IMPORT]) {
    for (const m of css.matchAll(re)) {
      const raw = m[2]!.trim();
      if (!raw || /^(?:data|https?|about):|^\/\/|^#/i.test(raw)) continue;
      refs.push(new URL(raw, `http://mirror.invalid${fromPath}`).pathname);
    }
  }
  return refs;
}

const SCRIPT = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const TAG = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*?)?(\/?)>/g;
const ATTR = /(\s)([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
const URL_ATTRS = new Set(["href", "src", "action", "poster", "srcset", "imagesrcset"]);

/** Removes scripts and script preloads, leaving the server-rendered markup. */
export function stripScripts(html: string): string {
  return html.replace(SCRIPT, "").replace(TAG, (tag, name: string, attrs = "") => {
    if (name.toLowerCase() !== "link") return tag;
    const rel = /\srel\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    const as = /\sas\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    return rel === "modulepreload" || (rel === "preload" && as === "script") ? "" : tag;
  });
}

function attrValue(quoted: string | undefined): string | null {
  if (quoted === undefined) return null;
  return decodeAttr(quoted.startsWith('"') || quoted.startsWith("'") ? quoted.slice(1, -1) : quoted);
}

/** Every address the page's tags and styles name (scripts already removed). */
export function htmlRefs(html: string): string[] {
  const refs: string[] = [];
  for (const tag of html.matchAll(TAG)) {
    for (const attr of (tag[2] ?? "").matchAll(ATTR)) {
      const name = attr[2]!.toLowerCase();
      const value = attrValue(attr[3]);
      if (value === null) continue;
      if (name === "srcset" || name === "imagesrcset") refs.push(...value.split(",").map((s) => s.trim().split(/\s+/)[0]!).filter(Boolean));
      else if (URL_ATTRS.has(name)) refs.push(value);
      else if (name === "style") refs.push(...cssRefs(value, "/"));
    }
  }
  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) refs.push(...cssRefs(style[1]!, "/"));
  return refs;
}

/** The note at the top of every page, only when there is a full site to send readers to. */
function banner(ctx: RewriteContext): string {
  if (!ctx.primary) return "";
  const link = ctx.primary ? `<a href="${encodeAttr(ctx.primary + "/")}" style="color:inherit;text-decoration:underline">${escapeText(ctx.primary.replace(/^https?:\/\//, ""))}</a>` : "";
  return `<div data-pages-mirror="" style="position:sticky;top:0;z-index:1000;padding:6px 12px;font-size:13px;line-height:1.5;text-align:center;background:#fff7e0;color:#5c4300;border-bottom:1px solid #ecd9a0">`
    + `这是 ${escapeText(ctx.siteName)} 的只读镜像，每小时同步${link ? `；完整站点：${link}` : ""}</div>`;
}

/** A page as the mirror publishes it. */
export function rewriteHtml(html: string, ctx: RewriteContext): string {
  const stripped = stripScripts(html);
  const rewritten = stripped.replace(TAG, (tag, name: string, attrs: string | undefined, close: string) => {
    if (!attrs) return tag;
    const out = attrs.replace(ATTR, (whole, space: string, attrName: string, quoted: string | undefined) => {
      const key = attrName.toLowerCase();
      const value = attrValue(quoted);
      if (value === null) return whole;
      if (key === "style") return `${space}${attrName}="${encodeAttr(rewriteCss(value, ctx))}"`;
      if (!URL_ATTRS.has(key)) return whole;
      const mapped = key === "srcset" || key === "imagesrcset"
        ? mapSrcset(value, ctx)
        : mapUrl(value, ctx, key === "href" || key === "action");
      return mapped === null ? "" : `${space}${attrName}="${encodeAttr(mapped)}"`;
    });
    return `<${name}${out}${close}>`;
  });
  const styled = rewritten.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_w, open: string, css: string, end: string) => open + rewriteCss(css, ctx) + end);
  return /<body\b[^>]*>/i.test(styled) ? styled.replace(/<body\b[^>]*>/i, (body) => body + banner(ctx)) : banner(ctx) + styled;
}

/** The web manifest's root-relative addresses (start_url, icons) under the base. */
export function rewriteManifest(text: string, ctx: RewriteContext): string {
  return text.replace(/"(\/(?!\/)[^"]*)"/g, (_w, raw: string) => JSON.stringify(mapUrl(raw, ctx, false) ?? raw));
}

/** A not-found page for when the site's own cannot be read. */
export function fallbackNotFound(siteName: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>页面不存在 · ${escapeText(siteName)}</title></head>`
    + `<body><main style="max-width:40rem;margin:4rem auto;padding:0 1rem;font-family:system-ui,sans-serif"><h1>页面不存在</h1><p><a href="/">回到首页</a></p></main></body></html>`;
}
