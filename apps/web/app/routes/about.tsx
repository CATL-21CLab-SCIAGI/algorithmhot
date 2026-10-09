import { useState } from "react";
import { Link, useLoaderData } from "react-router";
import { apiGet } from "../lib/api.server";
import { ABOUT, SITE, withSubject } from "@aihot/industry/site";
import { organizationLd, pageMeta } from "../lib/seo";
import { Kicker } from "../components/ui/Kicker";
import { buttonClass } from "../components/ui/Controls";
import { IconArrowRight } from "../components/icons";

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

interface ContactSettings {
  wechatQr: string | null;
  feishuQr: string | null;
  /** The maker's X avatar through the image proxy, when the site follows that account. */
  makerAvatar?: string | null;
}

export async function loader({ request }: { request: Request }) {
  const contact = await apiGet<ContactSettings>("/api/site/contact", { signal: request.signal })
    .catch((): ContactSettings => ({ wechatQr: null, feishuQr: null, makerAvatar: null }));
  return { contact };
}

export function meta() {
  return pageMeta({ title: "关于", description: `关于 ${SITE.name}：${SITE.description}`, path: "/about", image: "/og/pages/about.png", jsonLd: organizationLd() });
}

/**
 * Reading principles keep the site's hairline columns: one on phones, two from sm, four from lg.
 */
const STAGE_CELL = [
  "sm:pr-6 lg:pr-6",
  "border-t sm:border-l sm:border-t-0 sm:pl-6 lg:px-6",
  "border-t sm:pr-6 lg:border-l lg:border-t-0 lg:px-6",
  "border-t sm:border-l sm:pl-6 lg:border-t-0 lg:px-6",
];

interface Stage {
  no: string;
  title: string;
  text: string;
  note?: string;
}

const STAGES: Stage[] = [
    {
      no: "01",
      title: "研究来源",
      text: ABOUT.steps.collect,
    },
    {
      no: "02",
      title: "资料整理",
      text: ABOUT.steps.store,
    },
    {
      no: "03",
      title: "阅读精选",
      text: ABOUT.steps.select,
      note: "比较条件与证据限制随文章保留；作者报告不等于独立复现。",
    },
    {
      no: "04",
      title: "图文刊物",
      text: ABOUT.steps.publish,
      note: "也可以用 RSS、API、MCP 订阅",
    },
  ];

/** The maker's round avatar before the greeting; it steps aside if the image fails. */
function MakerFace({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <img src={src} alt={`${ABOUT.maker?.name ?? ""}的头像`} width={48} height={48} onError={() => setFailed(true)} className="size-11 shrink-0 rounded-full bg-bg-sunk object-cover ring-1 ring-line xl:size-12" />;
}

function QrCard({ src, kind, title, note }: { src: string; kind: string; title: string; note: string }) {
  return (
    <figure className="card flex items-center gap-5 p-5">
      <img src={src} alt={`${kind}二维码`} width={112} height={112} loading="lazy" className="size-[104px] shrink-0 rounded-tile border border-line bg-white object-contain p-1.5 sm:size-[112px]" />
      <figcaption className="min-w-0">
        <div className="text-[12px] text-ink-4">{kind}</div>
        <div className="mt-1 text-[16px] font-semibold leading-snug text-ink">{title}</div>
        <p className="mt-2 text-[13px] leading-[1.7] text-ink-3">{note}</p>
      </figcaption>
    </figure>
  );
}

/** The optional maker block (ABOUT.maker): a greeting on the left, the contact codes that are set on the right. */
function Maker({ maker, contact }: { maker: NonNullable<typeof ABOUT.maker>; contact: ContactSettings }) {
  const codes = [
    contact.wechatQr && maker.wechat ? <QrCard key="wechat" src={contact.wechatQr} kind="微信公众号" title={maker.wechat.title} note={maker.wechat.note} /> : null,
    contact.feishuQr && maker.feishu ? <QrCard key="feishu" src={contact.feishuQr} kind="飞书群" title={maker.feishu.title} note={maker.feishu.note} /> : null,
  ].filter(Boolean);
  return (
    <section aria-labelledby="maker" className="mt-20 grid gap-10 xl:mt-28 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
      <div>
        <Kicker>做这个站的人</Kicker>
        <h2 id="maker" className="mt-4 flex items-center gap-3.5 text-[26px] font-black leading-[1.3] tracking-[-0.02em] text-ink xl:gap-4 xl:text-[34px]">
          {contact.makerAvatar && <MakerFace src={contact.makerAvatar} />}
          <span>
            嗨，我是 <span className="whitespace-nowrap text-accent">{maker.name}</span>
          </span>
        </h2>
        <div className="mt-5 space-y-4 text-[15.5px] leading-[1.9] text-ink-2 xl:text-[16.5px]">
          {maker.greeting.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p className="text-ink-3">
            它一直在改，改了什么都写在
            <Link to="/changelog" className="text-accent hover:underline">
              更新日志
            </Link>
            里；有想法、遇到问题，去
            <Link to="/feedback" className="text-accent hover:underline">
              反馈页
            </Link>
            告诉我。
          </p>
        </div>
      </div>
      {codes.length > 0 && (
        <div className="grid content-start gap-3">
          <h3 className="text-[15px] font-semibold text-ink">如果觉得有点用，欢迎加入</h3>
          {codes}
        </div>
      )}
    </section>
  );
}

export default function AboutPage() {
  const { contact } = useLoaderData<typeof loader>();

  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-14 pt-6 lg:pt-3">
      <header className="grid items-end gap-8 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <Kicker>{ABOUT.kicker}</Kicker>
          <h1 className="mt-5 text-[34px] font-black leading-[1.18] tracking-[-0.03em] text-ink [text-wrap:balance] sm:text-[46px] xl:text-[56px] 2xl:text-[64px]">
            {ABOUT.headline[0]}
            <br />
            <span className="text-accent">{ABOUT.headline[1]}</span>
          </h1>
          <p className="mt-5 max-w-[36em] text-[15.5px] leading-[1.85] text-ink-3 xl:text-[17px]">
            {ABOUT.lead}
          </p>
        </div>
        <div className="flex flex-wrap gap-3 lg:pb-2">
          <Link to="/" prefetch="intent" className={buttonClass("primary", "lg")}>
            看今天的精选 <IconArrowRight size={15} />
          </Link>
          <Link to="/daily" prefetch="intent" className={buttonClass("secondary", "lg")}>
            读最新{withSubject("日报")}
          </Link>
        </div>
      </header>

      <section aria-labelledby="how" className="mt-10 xl:mt-14">
        <h2 id="how" className="sr-only">
          {SITE.name} 如何组织科研阅读
        </h2>
        <ol className="grid grid-cols-1 border-t border-line-strong sm:grid-cols-2 lg:grid-cols-4">
          {STAGES.map((s, i) => (
            <li
              key={s.no}
              className={`border-line py-6 ${STAGE_CELL[i]}`}
            >
              <div className="flex items-baseline gap-2.5">
                <span className="num text-[12px] font-bold tracking-[0.12em] text-accent">{s.no}</span>
                <h3 className="text-[17px] font-bold text-ink">{s.title}</h3>
              </div>
              <p className="mt-3 text-[14px] leading-[1.8] text-ink-3">{s.text}</p>
              {s.note && <p className="mt-3 text-[12px] text-ink-4">{s.note}</p>}
            </li>
          ))}
        </ol>
      </section>

      {ABOUT.maker && <Maker maker={ABOUT.maker} contact={contact} />}

      <p className="mt-16 well rounded-card px-5 py-4 text-[13px] leading-[1.85] text-ink-3">
        {ABOUT.copyright}
        <Link to="/feedback" className="text-accent hover:underline">
          反馈页
        </Link>
        联系我们。
      </p>

      <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-[12.5px] text-ink-4">
        <span>{SITE.footerNote}</span>
        <nav className="flex gap-5" aria-label="规则与隐私">
          <Link to="/terms" className="transition-colors hover:text-accent">
            使用规则
          </Link>
          <Link to="/privacy" className="transition-colors hover:text-accent">
            隐私说明
          </Link>
        </nav>
      </footer>
    </div>
  );
}
