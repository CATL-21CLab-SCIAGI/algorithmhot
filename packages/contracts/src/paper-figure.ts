import type { ResearchPaperFigure } from "./research.ts";

/** Narrow the public figure to a frozen, version-bound original. No private review fields escape. */
export function publicPaperFigure(value: unknown, itemId: string | null, sourceRevision: number | null): ResearchPaperFigure | null {
  if (!value || typeof value !== "object" || !itemId || !sourceRevision) return null;
  const f = value as Record<string, unknown>;
  const text = (key: string) => typeof f[key] === "string" ? f[key] as string : "";
  const remote = (value: string, fragment = true) => {
    try {
      const u = new URL(value), host = u.hostname.toLowerCase().replace(/\.$/, "");
      return value.length <= 2048 && u.href === value && u.protocol === "https:" && !u.username && !u.password && !u.port && (fragment || !u.hash)
        && host === u.hostname && host.includes(".") && /^[a-z0-9.-]+$/.test(host) && !/^[\d.]+$/.test(host) && !/\.(?:local|localhost|internal|test|invalid)$/.test(host);
    } catch { return false; }
  };
  const imageUrl = text("imageUrl"), imageOrigin = f.imageOrigin;
  if (f.itemId !== itemId || f.sourceRevision !== sourceRevision || !Number.isSafeInteger(sourceRevision) || sourceRevision < 1 ||
      !["remote", "pdf-extract"].includes(String(imageOrigin)) ||
      !(imageOrigin === "pdf-extract" ? /^\/paper-figures\/[A-Za-z0-9_-]+\.png$/.test(imageUrl) && f.contentType === "image/png" : remote(imageUrl, false)) ||
      !remote(text("sourceUrl")) || !remote(text("licenseUrl")) || !/^[a-f0-9]{64}$/.test(text("sha256")) ||
      !["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/gif"].includes(text("contentType")) ||
      !Number.isSafeInteger(f.width) || Number(f.width) <= 0 || Number(f.width) > 50000 || !Number.isSafeInteger(f.height) || Number(f.height) <= 0 || Number(f.height) > 50000 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text("verifiedAt")) || !Number.isFinite(Date.parse(text("verifiedAt"))) ||
      ["figureLabel", "caption", "attribution", "licenseName"].some(k => !text(k) || text(k).trim() !== text(k) || text(k).length > 10000 || /[<>\u0000-\u0008]/.test(text(k)))) return null;
  return { itemId, sourceRevision, imageOrigin: imageOrigin as ResearchPaperFigure["imageOrigin"], imageUrl,
    sourceUrl: text("sourceUrl"), figureLabel: text("figureLabel"), caption: text("caption"), attribution: text("attribution"),
    licenseName: text("licenseName"), licenseUrl: text("licenseUrl"), verifiedAt: text("verifiedAt"),
    width: Number(f.width), height: Number(f.height), contentType: text("contentType"), sha256: text("sha256") };
}
