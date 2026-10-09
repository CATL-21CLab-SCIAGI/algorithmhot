// 站点身份和读者看得到的文案。换成你的行业时，先改这个文件。
// 网页和后端都读它；改完重新构建（docker compose up --build）即可生效。
// 域名不在这里：部署时用环境变量 SITE_URL 设置。

export const SITE = {
  /** 站名：导航、页面标题、分享图、RSS、MCP、后台都用它。 */
  name: "AlgorithmHot · 科研热点",
  /**
   * 行业词：拼进默认说法里，比如“AI 日报”“AI 动态”。
   * 改成“法律”“HR”“黄金”之类，页面上就会变成“法律日报”“法律动态”。
   */
  subject: "科研",
  /** 首页的完整标题（浏览器标签、搜索结果）。 */
  homeTitle: "AlgorithmHot · 科研热点 — 算法、AI4AI、AI4S",
  /** 一句话介绍：搜索引擎、分享卡片、RSS、llms.txt 会用。 */
  description: "面向研究人员的算法、AI4AI 与 AI4S 阅读索引：追踪方法增量、适用任务、比较条件和证据限制，保留论文与实现入口。",
  /** 首页左上角和侧边栏下面的一行小字。 */
  tagline: "读方法，也读证据与边界",
  /** 界面语言（HTML lang、og:locale）。 */
  locale: "zh-CN",
  /** 默认域名，只在没设置 SITE_URL 时使用。 */
  defaultUrl: "http://127.0.0.1:3100",
  /**
   * MCP 工具名的前缀（小写字母、数字、下划线），工具会叫 myhot_get_latest、myhot_search……
   * 已经有人接入后就不要再改。
   */
  mcpPrefix: "algorithmhot",
  /** 对外联系邮箱（选填）：使用规则、llms.txt、响应头里会写。 */
  contactEmail: null as string | null,
  /** 页脚的一行小字（选填）。 */
  footerNote: "每天 09:00 · 15:00 · 21:00 更新",
  /** 中国大陆网站的 ICP 备案号（选填），填了就显示在页脚并链接到工信部备案系统。 */
  icp: null as string | null,
  /** 结构化数据里的网站运营者（搜索引擎用）。 */
  organization: {
    name: "AlgorithmHot · 科研热点",
    /** 创始人（选填）：{ name, url, description }。 */
    founder: null as null | { name: string; url?: string; description?: string },
  },
  /** 抓取信源时报上的名字（User-Agent 里用），不要冒用别的站。 */
  crawlerName: "algorithmhot",
} as const;

/** 关于页的文案。数字（信源数、收录数、精选数、日报期数）来自站内实时统计，不用写在这里。 */
export const ABOUT = {
  kicker: `关于 ${SITE.name}`,
  /** 大标题：第一行正常颜色，第二行强调色。 */
  headline: ["追踪研究方法的变化，", "保留证据与适用边界。"] as [string, string],
  /** 标题下面的一段话。{sources} 会换成实时的信源数。 */
  lead: `${SITE.name} 整理算法、AI4AI 与 AI4S 的研究进展，结合论文原图、中文解读与原文入口，帮助研究人员快速理解方法及其适用条件。`,
  /** 信源河动画下面的四个环节。 */
  steps: {
    collect: "阅读 arXiv、Hugging Face Daily Papers、Google DeepMind 与 Berkeley BAIR 等公开来源，追踪研究与社区动态。",
    store: "同一研究的论文、实现与后续修订整理在一起，保留原始日期和来源入口。",
    select: "优先选择有方法增量、明确比较条件与研究价值的工作，帮助读者从动态中找到值得细读的论文。",
    publish: "日报每天 09:00、15:00、21:00 更新，周报每周一 09:00 回顾上周，月报每月 1 日 09:00 回顾上月，均为北京时间。每篇附原图、方法解读与原文出处。",
  },
  /**
   * 作者块（选填），null 就不显示。
   * avatarSourceId：一个 X 账号信源的 id，头像取它的（选填）。
   * 二维码在后台“设置”里上传，或者放进 industry/brand/contact/；没有二维码就不显示那张卡片。
   */
  maker: null as null | {
    name: string;
    greeting: string[];
    avatarSourceId?: string | null;
    wechat?: { title: string; note: string };
    feishu?: { title: string; note: string };
  },
  /** 页面底部的版权与下架说明（结尾会接“反馈页”的链接）。 */
  copyright: `${SITE.name} 是聚合摘要和阅读索引，原文版权归各来源所有。如果你是来源方，希望更正、下架或调整展示方式，可以通过`,
} as const;

/** “AI 日报”这类说法：行业词和名词之间，英文词加空格，中文词不加。 */
export function withSubject(noun: string): string {
  return /[A-Za-z0-9]$/.test(SITE.subject) ? `${SITE.subject} ${noun}` : `${SITE.subject}${noun}`;
}

/** “按主题看 AI”“往期 AI 日报”这类说法：行业词接在中文后面，英文词前加空格，中文词不加；noun 照 withSubject 接上。 */
export function subjectAfter(text: string, noun?: string): string {
  const gap = /^[A-Za-z0-9]/.test(SITE.subject) ? " " : "";
  return `${text}${gap}${noun ? withSubject(noun) : SITE.subject}`;
}
