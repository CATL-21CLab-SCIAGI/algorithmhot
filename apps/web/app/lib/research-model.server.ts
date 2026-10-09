import { researchModelOverview, type ResearchModelPanelData } from "./research-model.ts";

/** A signed-out reader keeps the public Agent page; no private DTO is read without a session. */
export async function loadResearchModelPanel(request: Request, fetcher: typeof fetch = fetch): Promise<ResearchModelPanelData> {
  const base = process.env.API_BASE_URL || "http://127.0.0.1:3101";
  const options: RequestInit = {
    headers: { accept: "application/json", cookie: request.headers.get("cookie") ?? "", "user-agent": request.headers.get("user-agent") ?? "" },
    cache: "no-store", redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
  };
  try {
    const session = await fetcher(`${base}/api/admin/me`, options);
    if (session.status === 401 || session.status === 403) return { kind: "anonymous" };
    if (!session.ok) return { kind: "unavailable" };
    const me = await session.json();
    if (typeof me?.csrf !== "string" || !me.csrf) return { kind: "unavailable" };
    const response = await fetcher(`${base}/api/admin/research-model`, options);
    if (response.status === 401 || response.status === 403) return { kind: "anonymous" };
    if (!response.ok) return { kind: "unavailable" };
    return { kind: "admin", csrf: me.csrf, overview: researchModelOverview(await response.json()) };
  } catch { return { kind: "unavailable" }; }
}
