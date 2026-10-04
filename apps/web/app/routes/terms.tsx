import { SITE } from "@aihot/industry/site";
import { pageMeta } from "../lib/seo";
import { prepareCopy } from "../lib/site-copy";
import copy from "@aihot/industry/pages/terms.md?raw";
import { CopyPage, LegalFooterLinks } from "../features/copy/CopyPage";

const TERMS = prepareCopy(copy);

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export function meta() {
  return pageMeta({ title: "使用规则", description: `本站网站、RSS、公开 API 与 MCP 的使用规则。`, path: "/terms", image: "/og/pages/terms.png" });
}

export default function TermsPage() {
  return (
    <CopyPage
      doc={TERMS.doc}
      rendered={TERMS.rendered}
      eyebrow={SITE.name}
      footer={<LegalFooterLinks links={[{ to: "/privacy", label: "隐私说明" }, { to: "/agent", label: "Agent 接入页" }]} note={`使用规则 ${TERMS.doc.meta["版本"] ?? ""} · ${TERMS.doc.meta["生效日期"] ?? ""}`} />}
    />
  );
}
