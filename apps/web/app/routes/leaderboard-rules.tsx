// Public method statement for the leaderboard (method v15, docs/leaderboard.md).
// The copy states how rankings are actually computed; it changes only together with the method.
import { SITE, withSubject } from "@aihot/industry/site";
import { Link, useLoaderData } from "react-router";
import type { LbRunInfo } from "@aihot/contracts/leaderboard";
import { loadOr404 } from "../lib/api.server";
import { breadcrumbLd, pageMeta } from "../lib/seo";
import { pct } from "../features/leaderboard/format";
import { fullDateTime } from "../lib/format";
import { IconArrowLeft, IconChevronRight } from "../components/icons";
import { AsideCard, ReadingLayout } from "../components/ui/Page";

interface RulesData {
  run: LbRunInfo;
  budgets: Array<{ key: string; name: string; weight: number; sources: string[] }>;
  anchors: string[];
}

export async function loader({ request }: { request: Request }) {
  return loadOr404<RulesData>("/api/site/leaderboard/rules", { signal: request.signal });
}

export function meta() {
  return pageMeta({
    title: "共识指数计算方法",
    description: `查看 ${SITE.name} 模型榜如何核验公开成绩、比较共同参评结果、处理缺失证据，并确定排名和 0—100 共识指数。`,
    path: "/leaderboard/rules",
    image: "/og/pages/leaderboard.png",
    jsonLd: breadcrumbLd([
      { name: "模型榜", path: "/leaderboard" },
      { name: "排名怎么算", path: "/leaderboard/rules" },
    ]),
  });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=3600" };
}

const STEPS = [
  {
    n: "01",
    title: "先确认，是同一个模型",
    body: "统一各家榜单的名称和版本。同一模型的不同推理档位只选一个代表配置，选择规则预先确定，不挑最高分。匿名测试代号和混用其他模型完成任务的成绩排除；已正式公开的 Preview 版本可以参加。",
  },
  {
    n: "02",
    title: "让真正测过的模型相互比较",
    body: "只比较同一评测中的真实成绩。双方都有公开误差时，误差范围内的微小差异更接近平局，不当成确定胜负。没有测到，就没有这一场比较。",
  },
  {
    n: "03",
    title: "先定票权，再汇总共同意见",
    body: "每项评测使用预先确定的预算。综合榜至少要求三家评测机构、三个证据家族与三个专项覆盖；同一来源重复抓取或展示切片，不会凭空增加票权。",
  },
  {
    n: "04",
    title: "寻找冲突最少的完整排名",
    body: "不同评测的意见可能冲突。我们选择违背共同证据净票权最少的一条顺序，再单独计算展示指数。缺测不补零分，也不猜测未公开的成绩。",
  },
];

const FAQ = [
  {
    q: "为什么有的模型证据较少，也能上榜？",
    a: "评测数量与能力是两件事。综合榜至少需要三家机构与跨能力证据。多数分类要求两家机构，知识采用同一机构的两项评测并明确说明。缺测不记零分，但仍可能造成偏差。",
  },
  {
    q: "“证据敏感”是什么意思？",
    a: "删去一项评测或一家机构、将单项权重上下调整 20%、或改变误差处理后，名次范围达到三名或以上、某些情景失去参评资格，或有对照未完成，就会提示证据敏感。详情页的情景范围不是 95% 置信区间，不包含未知成绩。",
  },
  {
    q: "前面的模型一定在两两比较中获胜吗？",
    a: "不一定。A 可能胜 B，B 胜 C，C 又胜 A。完整榜单要权衡这些冲突；非相邻名次可能与单独比较不同。数学最优表示按当前规则的总冲突最少，不表示已证明所有真实工作中的能力顺序。",
  },
  {
    q: "为什么排名可能和我的体验不同？",
    a: "榜单汇集公开评测，反映这些证据支持的综合能力。实际体验还受产品版本、推理档位、工具环境和长任务稳定性影响。我们会用新评测检验旧排名；分数接近时，不应把一两名之差理解成明显强弱。",
  },
  {
    q: "新模型什么时候会出现？",
    a: `${SITE.name} 每天检查四次上游结果。只有评测方实际发布了新模型的成绩，才能用于排名；网页刷新、价格更新或我们的抓取时间，都不算重新评测。`,
  },
  {
    q: "某家榜单暂时打不开，会怎样？",
    a: "仍有效的来源快照可继续使用。相同评测版本内，临时漏行最多沿用最近七天已核验的记录；仍在公开榜中保留的有效成绩，不因数值长期不变被删除。官方撤回、更正、换版会相应失效或替换，不保留历史最高分。整轮计算失败时保留上一轮有效榜及原时间。",
  },
  {
    q: "综合指数会和专项评测重复计分吗？",
    a: "我们根据公开的题库与方法说明检查重叠，并限制相关来源的总份额；无法确认的相关性仍是局限。当前 AA 指数占 30%；Arena 整体文本与创作专项共享原有 10% 真人偏好份额，各占 5%。两项有重叠投票，因此仍算同一个证据家族，不假装是两家独立评测。",
  },
  {
    q: "价格或速度会影响排名吗？",
    a: "都不会。价格只供你了解 API 的使用成本，统一按每百万 Token 展示，并保留厂商官方来源。它不代表订阅费用。",
  },
];

const SECTIONS = [
  ["#rules-steps", "四步得出排名"],
  ["#rules-budgets", "证据怎么分配"],
  ["#rules-faq", "常见问题"],
  ["#rules-details", "计算细节"],
] as const;

/** One question or detail block: a hairline row that opens in place. */
function Disclosure({ summary, children, defaultOpen = false }: { summary: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="disclosure group border-b border-line" open={defaultOpen}>
      <summary className="flex items-center justify-between gap-3 py-4 text-[14px] font-semibold text-ink transition-colors hover:text-accent">
        {summary}
        <span className="shrink-0 text-[18px] font-normal leading-none text-ink-4 transition-transform duration-200 group-open:rotate-45" aria-hidden="true">
          +
        </span>
      </summary>
      <div className="max-w-[64em] pb-5 text-[13px] leading-[1.8] text-ink-3">{children}</div>
    </details>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <span className="mono text-[11px] font-semibold tracking-[0.14em] text-accent">{children}</span>;
}

export default function LeaderboardRulesPage() {
  const { run, budgets, anchors } = useLoaderData<typeof loader>();
  const aside = (
    <>
      <AsideCard title="本页内容" className="hidden lg:block">
        <nav aria-label="本页内容" className="-mx-2 -mb-1">
          {SECTIONS.map(([href, label]) => (
            <a key={href} href={href} className="block rounded-control px-2 py-2 text-[13.5px] text-ink-2 transition-colors hover:bg-bg-sunk hover:text-ink">
              {label}
            </a>
          ))}
        </nav>
      </AsideCard>
      <AsideCard title="当前方法">
        <dl className="space-y-2 text-[12.5px]">
          <div className="flex gap-3">
            <dt className="w-14 shrink-0 text-ink-4">方法版本</dt>
            <dd className="mono min-w-0 text-ink-2">{run.methodologyVersion}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-14 shrink-0 text-ink-4">本轮计算</dt>
            <dd className="mono min-w-0 text-ink-2">{fullDateTime(run.generatedAt)}</dd>
          </div>
        </dl>
      </AsideCard>
      <AsideCard title="继续看">
        <nav aria-label="继续看" className="-mx-2 -mb-1">
          {[
            ["/leaderboard", "模型榜"],
            ["/leaderboard/sources", "每一份评测证据"],
          ].map(([to, label]) => (
            <Link key={to} to={to!} prefetch="intent" className="flex items-center justify-between rounded-control px-2 py-2 text-[13.5px] text-ink-2 transition-colors hover:bg-bg-sunk hover:text-ink">
              {label}
              <IconChevronRight size={14} className="text-ink-4" />
            </Link>
          ))}
        </nav>
      </AsideCard>
    </>
  );
  return (
    <ReadingLayout aside={aside}>
      <Link to="/leaderboard" className="inline-flex items-center gap-1.5 py-2 text-[13px] text-ink-3 transition-colors hover:text-accent">
        <IconArrowLeft size={14} /> 返回模型榜
      </Link>

      <header className="pt-3">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">排名怎么算</h1>
        <p className="mt-1.5 text-[13px] text-ink-3">综合多家公开评测，了解排名背后的证据与方法。</p>
      </header>

      <section className="mt-6 grid items-center gap-5 rounded-panel border border-line-soft bg-bg-sunk px-6 py-7 dark:bg-bg-muted/40 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)] md:px-10 md:py-9 lg:grid-cols-1 xl:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
        <p className="mono text-[44px] font-medium leading-none tracking-[-0.04em] text-accent md:text-center md:text-[52px]">0—100</p>
        <div>
          <h2 className="text-[17px] font-bold text-ink">共同的证据，清楚的顺序。</h2>
          <p className="mt-2.5 text-[13px] leading-[1.8] text-ink-3">综合多家公开评测，在完整排名中尽量减少与已知成绩的冲突。综合榜和四类榜单都最多展示前 30 名。</p>
          <p className="mt-1.5 text-[13px] leading-[1.8] text-ink-3">
            共识指数把支持原排名的证据差异换算为 0—100，方便比较，不是正确率或能力差距的百分比。支持接近时可以同分，名次仍由完整证据决定。
          </p>
        </div>
      </section>

      <ol id="rules-steps" className="mt-8 grid scroll-mt-6 gap-x-10 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        {STEPS.map((s) => (
          <li key={s.n} className="border-b border-line py-5">
            <span className="mono text-[11px] text-ink-4">{s.n}</span>
            <h2 className="mt-2 text-[15px] font-bold text-ink">{s.title}</h2>
            <p className="mt-1.5 text-[13px] leading-[1.8] text-ink-3">{s.body}</p>
          </li>
        ))}
      </ol>

      <section id="rules-budgets" className="mt-12 scroll-mt-6">
        <Eyebrow>A BALANCED VIEW</Eyebrow>
        <h2 className="mt-2 text-[20px] font-bold text-ink">综合测试、真人盲选、专项评测，一起看。</h2>
        <p className="mt-1.5 max-w-[64em] text-[13px] leading-[1.8] text-ink-3">
          综合评测占 30%，真人盲选占 10%，各项专项评测合计占 60%。新增评测先核对公开说明中的重叠关系，再从对应份额中分配；缺失份额不转给其他评测。
        </p>
        <ul className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-label="证据预算分配">
          {budgets.map((b) => (
            <li key={b.key} className="card flex flex-col p-4 lg:p-5">
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-[13.5px] font-semibold text-ink">{b.name}</span>
                <span className="mono text-[20px] font-medium text-ink">{pct(b.weight, 0)}</span>
              </span>
              <span className="mt-2.5 text-[11.5px] leading-[1.7] text-ink-4">{b.sources.join(" · ") || "—"}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 max-w-[64em] text-[12.5px] leading-[1.8] text-ink-3">
          编程、推理、知识、专业办公分别寻找真实评测，分类分独立计算。视觉理解与多语言证据继续保留在综合榜；调整分类名称不会增加同一份成绩的投票权。综合分不等于分类分的算术平均。分类通常至少有两项有效评测、五个可比较型号才展示。知识目前由 Epoch 的两套评测支持，并明确说明同机构的局限。创作偏好、网页开发等证据继续用于综合榜，首版不单设审美和写作榜。
        </p>
      </section>

      <section id="rules-faq" className="mt-12 scroll-mt-6">
        <h2 className="text-[20px] font-bold text-ink">你可能还想知道</h2>
        <div className="mt-3 border-t border-line">
          {FAQ.map((f) => (
            <Disclosure key={f.q} summary={f.q}>
              {f.a}
            </Disclosure>
          ))}
        </div>
      </section>

      <section id="rules-details" className="mt-10 scroll-mt-6 border-t border-line">
        <Disclosure summary="查看计算细节与当前版本">
          <div className="space-y-3">
            <p>
              方法版本：<code className="mono rounded-mark bg-bg-sunk px-1.5 py-0.5 text-[12px] text-ink-2">{run.methodologyVersion}</code>。采用加权不完整 Kemeny 排序。每对共同参评模型汇总净支持 M；目标是最小化所有被排反的净支持之和。整数优化返回最优状态和目标上下界，只有完整通过验证的结果才用于正式发布。
            </p>
            <p>
              双方有明确标准误时，净支持取 2Φ(分差 / 合成标准误) − 1，默认零协方差；其他比较只取原始领先方向。未知误差并非零误差，小分差按序数处理仍是局限。票权针对潜在模型对，覆盖型号多的来源会使用更多比较位置，不能把名义预算解读为最终名次的精确贡献率。
            </p>
            <p>
              展示指数保留原排序：逐对反转相邻模型的先后，允许其余模型重排，计算最少增加的逆向净支持。沿原排名累加这些非负支持差，再相对固定参照组用 sigmoid 映射到 0—100。替代顺序同样最优时保留零间距，显示保留一位小数，不人为设置最低分差。指数不参与反向排序；入榜集合、参照型号与证据变化仍会影响指数，分差不等于真实能力距离。同代价求解固定型号 ID 次序；整数优化使用 HiGHS 求解器（highs 1.15.3），误差换算的正态分布函数与 SciPy norm.cdf 采用同一算法；来源、协议、参评资格和每轮计算输入均保存版本。未连接到共同证据网络时不发布跨分量的假精确顺序。
            </p>
            <p>
              固定参照型号：<span className="mono text-[12px] text-ink-2">{anchors.join("、")}</span>。参照组用于指数尺度，不指定任何厂商应排第几；不同分类的指数不直接比较。
            </p>
          </div>
        </Disclosure>
      </section>

      <Link to="/leaderboard/sources" className="mt-8 inline-flex items-center gap-1 text-[13.5px] font-medium text-accent hover:text-accent-ink">
        查看每一份评测证据 →
      </Link>
    </ReadingLayout>
  );
}
