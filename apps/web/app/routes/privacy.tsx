import { SITE } from "@aihot/industry/site";
import { pageMeta } from "../lib/seo";
import { prepareCopy } from "../lib/site-copy";
import copy from "@aihot/industry/pages/privacy.md?raw";
import { CopyPage, LegalFooterLinks } from "../features/copy/CopyPage";

const PRIVACY = prepareCopy(copy);

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export function meta() {
  return pageMeta({ title: "隐私说明", description: `本站如何处理浏览器本地数据、反馈资料与访问日志。`, path: "/privacy", image: "/og/pages/privacy.png" });
}

export default function PrivacyPage() {
  return (
    <CopyPage
      doc={PRIVACY.doc}
      rendered={PRIVACY.rendered}
      eyebrow={SITE.name}
      footer={<LegalFooterLinks links={[{ to: "/terms", label: "使用规则" }, { to: "/feedback", label: "反馈页" }]} note={`隐私说明 ${PRIVACY.doc.meta["版本"] ?? ""} · ${PRIVACY.doc.meta["生效日期"] ?? ""}`} />}
    />
  );
}
