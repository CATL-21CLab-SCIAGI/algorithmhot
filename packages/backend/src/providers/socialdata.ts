// SocialData (X search). Paid per request: every call goes through receipts and the budget.
import { credential } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { paidRequest, ProviderRejectedError } from "./receipts.ts";

export interface SdUser {
  name: string;
  screen_name: string;
  profile_image_url_https?: string;
}

export interface SdMedia {
  type: "photo" | "video" | "animated_gif";
  media_url_https: string;
  original_info?: { width?: number; height?: number };
}

export interface SdTweet {
  id_str: string;
  tweet_created_at: string;
  full_text?: string;
  text?: string;
  lang?: string;
  user: SdUser;
  in_reply_to_status_id_str?: string | null;
  in_reply_to_screen_name?: string | null;
  quoted_status?: SdTweet | null;
  retweeted_status?: SdTweet | null;
  is_quote_status?: boolean;
  entities?: { urls?: Array<{ url: string; expanded_url: string }>; media?: SdMedia[] };
  extended_entities?: { media?: SdMedia[] };
  favorite_count?: number;
  retweet_count?: number;
  reply_count?: number;
  quote_count?: number;
  views_count?: number;
}

export interface SearchResult {
  tweets: SdTweet[];
  nextCursor: string | null;
  receiptId: number;
  reused: boolean;
}

/**
 * SocialData bills US$0.20 per 1,000 objects returned by a successful response. Recorded per call as an
 * estimate.
 */
function objectsCost(objects: number) {
  return { amount: objects * 0.0002, currency: "USD", basis: "estimated" as const };
}

/** The API root; tests point it at a local stub. */
function apiBase(): string {
  return (credential("collectors", "SOCIALDATA_BASE_URL") ?? "https://api.socialdata.tools").replace(/\/$/, "");
}

/**
 * Searches recent tweets. `window` makes the receipt identity time-bucketed so a retry in the same
 * bucket reuses the stored response instead of paying again.
 */
export async function searchTweets(query: string, opts: { purpose: string; subject: string; window: string; type?: "Latest" | "Top"; cursor?: string | null }): Promise<SearchResult> {
  const key = credential("collectors", "SOCIALDATA_API_KEY");
  if (!key) throw new Error("SOCIALDATA_API_KEY is not configured");
  const type = opts.type ?? "Latest";
  const receipt = await paidRequest(
    { service: "socialdata", purpose: opts.purpose, subject: opts.subject, identity: { query, type, cursor: opts.cursor ?? null, window: opts.window }, requestSummary: { query, type } },
    async () => {
      const sp = new URLSearchParams({ query, type });
      if (opts.cursor) sp.set("cursor", opts.cursor);
      const res = await guardedFetch(`${apiBase()}/twitter/search?${sp}`, {
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        // Deeper pages of a search over two dozen accounts can take well over 20 seconds.
        timeoutMs: 60_000,
        maxBytes: 12 * 1024 * 1024,
        route: "direct",
      });
      const text = res.text();
      if (res.status === 402 || res.status === 401 || res.status === 403 || res.status === 400 || res.status === 422) {
        throw new ProviderRejectedError(`socialdata HTTP ${res.status}: ${text.slice(0, 200)}`, res.status, false);
      }
      if (res.status === 429 || res.status >= 500) throw new ProviderRejectedError(`socialdata HTTP ${res.status}`, res.status, true);
      const json = JSON.parse(text) as { tweets?: SdTweet[]; next_cursor?: string | null };
      const tweets = json.tweets?.length ?? 0;
      return { response: json, usage: { tweets }, cost: objectsCost(tweets) };
    },
  );
  const json = receipt.response as { tweets?: SdTweet[]; next_cursor?: string | null };
  return { tweets: json.tweets ?? [], nextCursor: json.next_cursor ?? null, receiptId: receipt.receiptId, reused: receipt.reused };
}

export function tweetText(t: SdTweet): string {
  let text = t.full_text ?? t.text ?? "";
  // Expand t.co links and drop trailing media links.
  for (const u of t.entities?.urls ?? []) text = text.replaceAll(u.url, u.expanded_url);
  for (const m of t.extended_entities?.media ?? t.entities?.media ?? []) text = text.replace(/\s*https:\/\/t\.co\/\w+\s*$/, "");
  return text.trim();
}

export function tweetMedia(t: SdTweet) {
  return (t.extended_entities?.media ?? t.entities?.media ?? []).map((m) => ({
    kind: m.type === "photo" ? ("image" as const) : ("video" as const),
    url: m.media_url_https,
    width: m.original_info?.width ?? null,
    height: m.original_info?.height ?? null,
    poster: m.type === "photo" ? null : m.media_url_https,
  }));
}

/** An X Article: its title and body as DraftJS blocks (header-two, blockquote, list items, atomic media…). */
export interface SdArticle {
  title?: string;
  content_state?: { blocks?: Array<{ type?: string; text?: string }> };
}

/**
 * The long-form article a post published, looked up by the id of that post (the number in an
 * `x.com/i/article/<id>` link is not it). Null when the post published none. Paid per article.
 */
export async function getArticle(tweetId: string, opts: { purpose: string; subject: string }): Promise<SdArticle | null> {
  const key = credential("collectors", "SOCIALDATA_API_KEY");
  if (!key) throw new Error("SOCIALDATA_API_KEY is not configured");
  const receipt = await paidRequest(
    { service: "socialdata", purpose: opts.purpose, subject: opts.subject, identity: { article: tweetId }, requestSummary: { article: tweetId } },
    async () => {
      const res = await guardedFetch(`${apiBase()}/twitter/article/${encodeURIComponent(tweetId)}`, {
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        timeoutMs: 30_000,
        maxBytes: 4 * 1024 * 1024,
        route: "direct",
      });
      const text = res.text();
      if (res.status === 404) return { response: null, usage: { articles: 0 }, cost: null };
      if (res.status === 402 || res.status === 401 || res.status === 403 || res.status === 400 || res.status === 422) {
        throw new ProviderRejectedError(`socialdata HTTP ${res.status}: ${text.slice(0, 200)}`, res.status, false);
      }
      if (res.status === 429 || res.status >= 500) throw new ProviderRejectedError(`socialdata HTTP ${res.status}`, res.status, true);
      // A post without an article answers with the post alone, or with {status: "error"}.
      const json = JSON.parse(text) as { article?: SdArticle; status?: string };
      const article = json.status === "error" ? null : (json.article ?? null);
      return { response: article, usage: { articles: article ? 1 : 0 }, cost: objectsCost(1) };
    },
  );
  return (receipt.response as SdArticle | null) ?? null;
}

/** One tweet by id (context for replies and quotes). Paid; the receipt makes retries free. */
export async function getTweet(id: string, opts: { purpose: string; subject: string }): Promise<SdTweet | null> {
  const key = credential("collectors", "SOCIALDATA_API_KEY");
  if (!key) throw new Error("SOCIALDATA_API_KEY is not configured");
  const receipt = await paidRequest(
    { service: "socialdata", purpose: opts.purpose, subject: opts.subject, identity: { tweet: id }, requestSummary: { tweet: id } },
    async () => {
      const res = await guardedFetch(`${apiBase()}/twitter/tweets/${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        timeoutMs: 30_000,
        maxBytes: 4 * 1024 * 1024,
        route: "direct",
      });
      const text = res.text();
      if (res.status === 404) return { response: null, usage: { tweets: 0 }, cost: null };
      if (res.status === 402 || res.status === 401 || res.status === 403 || res.status === 400 || res.status === 422) {
        throw new ProviderRejectedError(`socialdata HTTP ${res.status}: ${text.slice(0, 200)}`, res.status, false);
      }
      if (res.status === 429 || res.status >= 500) throw new ProviderRejectedError(`socialdata HTTP ${res.status}`, res.status, true);
      return { response: JSON.parse(text) as SdTweet, usage: { tweets: 1 }, cost: objectsCost(1) };
    },
  );
  return (receipt.response as SdTweet | null) ?? null;
}
