# AlgorithmHot · 科研热点

**公网阅读：[https://catl-21clab-sciagi.github.io/algorithmhot/](https://catl-21clab-sciagi.github.io/algorithmhot/)**

[科研日报](https://catl-21clab-sciagi.github.io/algorithmhot/daily/) · [科研周报](https://catl-21clab-sciagi.github.io/algorithmhot/weekly/) · [主题浏览](https://catl-21clab-sciagi.github.io/algorithmhot/topics/)

面向研究人员的中文科研阅读站，追踪**算法、AI4AI、AI4S、电池与新能源材料**。从论文公告、期刊元数据、机构博客和社区推荐中收集资料，生成中文标题、摘要与推荐理由，按研究事件归组，并整理为日报、周报和月报。

阅读重点是：**方法有什么变化、适用于什么任务、比较条件是什么、证据有哪些限制**。站点保留原文及可获得的实现入口；模型摘要和作者报告的结果不等于独立复现。

[在线阅读镜像](https://catl-21clab-sciagi.github.io/algorithmhot/) · [部署与运行](#部署与运行) · [配置](#配置) · [文档](#文档) · [English](README.en.md)

`main` 保存源码，`gh-pages` 保存另行发布的静态阅读镜像。克隆源码不包含历史论文数据库、模型凭据或运行记录，推送源码也不会自动刷新阅读镜像。

界面截图采于 **2026-10-14（北京时间）**，均为当前公网镜像的真实页面。点击图片可打开对应页面；截图来源与时间见 [记录](docs/screenshots/2026-10-14/manifest.json)。

[![精选首页：按日期浏览研究摘要、来源与推荐理由。](docs/screenshots/2026-10-14/home.png)](https://catl-21clab-sciagi.github.io/algorithmhot/)

*精选首页：按日期浏览研究摘要、来源与推荐理由。*

## 研究范围

| 方向 | 关注内容 |
| --- | --- |
| 算法 | AI / 机器学习的训练、推理、优化、模型架构与理论方法 |
| AI4AI | 自动研究、实验设计、训练数据与奖励构建、能力评测、Agent 框架及 AI 研发流程 |
| AI4S | AI 直接服务材料、计算物理、分子建模、定量生物学等科学问题 |
| 电池与新能源材料 | 电池材料与界面、退化与安全、光伏、制氢电催化等原创材料研究，不要求以 AI 为核心方法 |

分类定义在 [industry/taxonomy.ts](industry/taxonomy.ts)。直接服务科学问题的 AI 工作优先归入 AI4S；没有以 AI 为核心方法的新能源材料研究归入材料方向。交叉主题通过标签表达。


[![AI4S 分类：按研究方向查看论文卡片和来源注记。](docs/screenshots/2026-10-14/ai4s.png)](https://catl-21clab-sciagi.github.io/algorithmhot/c/ai4s/)

*AI4S 分类：按研究方向查看论文卡片和来源注记。*

## 当前提供的功能

- **科研资料采集**：arXiv 公告、Crossref 期刊元数据，以及机构博客和社区论文推荐。
- **中文阅读与筛选**：预筛、两次独立评分、内容理解、中文标题与摘要、推荐理由和分类标签。评分标准与提示词保存在仓库中。
- **事件与热点**：将相关报道归到研究事件，保留来源；热点采用 7 天窗口和 48 小时半衰期，至少需要两个独立参与方。热度表达关注度，不代表科学可靠性。
- **日报、周报、月报**：按来源上线时间组织资料，支持缺期补刊和显式修订。
- **来源注记与配图**：展示可获得的论文标识、日期、PDF、许可和图片来源；没有合适图片时保留缺图提示。
- **阅读与接入**：搜索、主题、收藏、未读筛选，以及 RSS、公开 API、MCP 和 Agent Markdown。
- **管理与运行记录**：信源状态、人工更正、模型配置、请求回执、请求次数上限和任务运行记录。

### 论文详情

[![论文详情：中文标题、原文入口、论文配图、来源注记与推荐理由。](docs/screenshots/2026-10-14/paper-detail.png)](https://catl-21clab-sciagi.github.io/algorithmhot/items/d0bjbamidu90d2u8fwfet74az/)

*论文详情：中文标题、原文入口、论文配图、来源注记与推荐理由。*

## 默认信源

| 来源 | 当前配置 |
| --- | --- |
| arXiv · AI 与机器学习 | `cs.LG`、`cs.AI` |
| arXiv · 计算物理与材料 | `physics.comp-ph`、`cond-mat.mtrl-sci` |
| arXiv · 分子与定量生物学 | `q-bio.BM`、`q-bio.QM` |
| Crossref 期刊 | Nature、Nature Energy、Nature Materials、Science、Angewandte Chemie International Edition、Journal of the American Chemical Society |
| 机构博客 | Google DeepMind、Berkeley BAIR |
| 社区论文推荐 | Hugging Face Daily Papers |

论文来源在 [industry/research-feeds.json](industry/research-feeds.json)，博客和社区来源在 [industry/sources.json](industry/sources.json)。期刊按 DOI 模式、部分期刊按关键词过滤，再进入模型筛选；配置来源不代表已经成功采集或完整覆盖该领域。

### 主题浏览

[![主题入口：按研究方向、资料类型、机构与社区组织内容。](docs/screenshots/2026-10-14/topics.png)](https://catl-21clab-sciagi.github.io/algorithmhot/topics/)

*主题入口：按研究方向、资料类型、机构与社区组织内容。*

## 处理流程与日期

```text
来源采集 → 去重与日期归属 → 预筛 → 两次评分 → 理解、摘要与分类
                                                 ↓
                                       事件归组 → 精选与热点
                                                 ↓
                                     日报 → 周报 / 月报
                                                 ↓
                                完整站点 → 可选 Pages 静态镜像
```

后端通过常驻 worker 和 PostgreSQL 中的 pg-boss 队列调度，不依赖一个持续打开的 Codex 会话。读者打开页面不触发模型调用。资料分析和周/月报导读等模型任务由 worker 执行。

**资料日期**：arXiv 读取分类公告页的新提交，以公告日期的北京时间 08:00 作为本站时间线归属时刻；这是站点规则。期刊优先使用 Crossref 的 `published-online`，缺失时用本站发现时间。其他资料使用可取得的来源发布时间；时间线不晚于本站发现时刻。只有日期、没有时分秒的资料按代码中的日期归属规则处理。

**日报**：D 日收录北京时间 `(D−1 日 08:00:00, D 日 08:00:00]` 的资料，按规则选文，成刊本身不调用模型。当前篇幅上限为 20 条正文、20 条快讯，同一信源最多占 8 条正文。12:00 前可以等待当日 arXiv 公告或窗口内资料判断完成；12:00 后解除这些等待条件，但没有已判断资料、任务失败等情况仍可能阻止成刊，不能保证每个日期都出刊。

**周报与月报**：分别在周一 10:00、每月 1 日 10:30 起按北京时间调度，从日报汇编；模型负责总述和栏目导读。出刊时间、篇幅与热点窗口在 [site/site.ts](site/site.ts) 配置。

定时任务默认补缺期，不覆盖已经生成的日报。需要补采后重编某一期时，使用显式的 `--replace`，旧版本保留为修订记录。

### 日报与周报界面

[![科研日报：截图展示 2026-10-13 期及历史期导航。](docs/screenshots/2026-10-14/daily.png)](https://catl-21clab-sciagi.github.io/algorithmhot/daily/)

*科研日报：截图展示 2026-10-13 期及历史期导航。*


[![科研周报：截图展示 2026 年第 41 周的导读、头条与栏目。](docs/screenshots/2026-10-14/weekly.png)](https://catl-21clab-sciagi.github.io/algorithmhot/weekly/)

*科研周报：截图展示 2026 年第 41 周的导读、头条与栏目。*

## 部署与运行

### Docker Compose

需要 Git、Node.js **24.11 或更新版本**（生成初始配置），以及 Docker 和 Compose 插件。容器内使用 Node.js 24 和 PostgreSQL 17。

```bash
git clone https://github.com/CATL-21CLab-SCIAGI/algorithmhot.git
cd algorithmhot
node scripts/init-env.ts
```

初始化脚本生成 `.env`、随机签名密钥、数据库密码和管理员密码，拒绝覆盖已有 `.env`。随后编辑 `.env`。首次只检查页面时，先将以下三项设为：

```dotenv
COLLECT_ENABLED=false
MODEL_CALLS_ENABLED=false
PAGES_MIRROR_ENABLED=false
```

```bash
docker compose up -d --build
docker compose ps
```

打开 [http://localhost:3000](http://localhost:3000)，管理入口为 `/admin`，密码见本机 `.env` 中的 `ADMIN_PASSWORD`。Compose 会完成数据库迁移、导入初始信源，并启动 API、网页和 worker；关闭采集与模型调用时，新数据库不会自动产生科研内容。

准备正式采集时，在 `.env` 中配置自己可用的 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 及请求上限，再将 `COLLECT_ENABLED`、`MODEL_CALLS_ENABLED` 设为 `true`，执行 `docker compose up -d` 使配置生效。启用后的 worker 会访问外部来源并发起模型请求，费用由配置的服务商收取。

域名、HTTPS、持久卷、备份与升级见 [部署指南](docs/deploy.md)；ECS 和 systemd 示例见 [阿里云部署说明](docs/deploy-aliyun.md)。这些是部署路径，不代表仓库已经替你部署了云服务。

### 本机常驻运行

也可以让 API、网页和 worker 直接在本机运行。需要 Node.js 24.11+、npm，以及可访问的 PostgreSQL 17；[本机脚本](scripts/local-stack.ts) 也能在需要时启动本机 Docker 数据库容器。

在已生成 `.env` 的仓库内：

```bash
npm ci
npm run build -w @aihot/web
```

配置 `DATABASE_URL` 和本机端口；若使用脚本管理的默认数据库容器，连接为 `postgres://aihot:<POSTGRES_PASSWORD>@127.0.0.1:55434/aihot`，将占位符替换为 `.env` 中的实际数据库密码。使用 Colima 时还需按环境设置 `LOCAL_DOCKER_HOST`、`LOCAL_COLIMA_PROFILE`。随后运行：

```bash
npm run local:up       # 数据库就绪、迁移、导入信源，并启动缺失的服务
npm run local:status   # 查看进程、日报、任务、来源健康与模型请求状态
npm run local:daily    # 执行 up，默认等待 60 秒，再报告状态
npm run local:down     # 停止本机 API、网页和 worker
```

`local:up` / `local:daily` 会写入运行状态、执行数据库迁移并启动 worker；采集、模型请求和镜像发布按 `.env` 开关运行。它们不是只读检查。默认日志位置为 `.data/local/logs/`。配置细节见 [本机运行说明](docs/local-daily.md)。

## 配置

| 位置 | 作用 |
| --- | --- |
| [.env.example](.env.example) | 地址、密钥、数据库、模型、请求上限和功能开关的配置模板 |
| [site/site.ts](site/site.ts) | 站点文案、出刊时间、日报篇幅、热点窗口 |
| [site/models.ts](site/models.ts) | 模型预设及各处理步骤的默认选择 |
| [industry/taxonomy.ts](industry/taxonomy.ts)、[industry/topics.json](industry/topics.json) | 分类、标签与主题 |
| [industry/sources.json](industry/sources.json)、[industry/research-feeds.json](industry/research-feeds.json) | 初始来源与论文来源配置 |
| [industry/prompts/](industry/prompts/) | 预筛、评分、内容理解、摘要和报告的提示词 |
| [industry/selection.ts](industry/selection.ts) | 按信源分级的入选门槛 |
| [site/pages/](site/pages/) | 使用规则与隐私说明，公开部署前应补全运营主体 |

模型使用 OpenAI 兼容接口。当前 `.env.example` 写有 AWS Bedrock 端点、`global.openai.gpt-6-astra` 和 `LLM_REASONING_API=true`；这是配置示例，账户权限、模型可用性和接口兼容性需在实际运行环境确认。切换服务商时同时核对推理参数、JSON 模式和输出额度。各步骤还可通过 `PREFILTER_MODEL`、`SCORE_MODEL` 等变量选择单独的模型。

`LLM_BUDGET_PER_MINUTE`、`LLM_BUDGET_PER_HOUR`、`LLM_BUDGET_PER_DAY` 设置默认 `llm` 服务在滚动时间窗口内的**请求尝试次数上限，不是金额**。达到上限后任务等待；`report_*` 写作请求豁免每日次数限制，仍受分钟和小时限制，任一额度为 0 时也会停止。切换到具名模型服务后，应在后台核对对应服务的额度。请求次数不能替代实际费用预算。

默认 Git 规则忽略 `.env`、`.env.*`（保留 `.env.example`）和 `.data/`。其他名称的凭据文件需自行排除，不要提交任何真实密钥。前端通过 HTTP 访问 API，数据库与模型密钥留在后端。

## 补采与补刊

在本机依赖和 `.env` 已就绪的环境中，以下命令会访问来源或写入数据库：

```bash
npm run research:backfill -- 2026-10-09 2026-10-12
npm run reports:daily -- 2026-10-10 2026-10-11
# 补采资料完成判断后，明确替换已有日报，并保留修订：
npm run reports:daily -- --replace 2026-10-10
```

日期仅为示例。补采后的资料仍需由 worker 判断；补刊默认跳过已有日报。arXiv 补采依赖来源的近期 `pastweek` 列表，不能任意回溯；结束日期只约束 arXiv，期刊按起始日期查询且有返回数量上限。命令成功不等于该日期范围的文献已完整收录。

## 完整站点与 Pages 镜像

完整站点提供数据库查询、搜索、管理后台以及下列匿名只读接入：

| 入口 | 用途 |
| --- | --- |
| `/agent` | 获取接入说明 |
| `/feed.xml`、`/feed/daily.xml` | 精选与日报 RSS |
| `/api/v1/agent`、`/llms.txt` | Agent 可读说明 |
| `/api/v1/items`、`/openapi-v1.json` | 公开资料与接口定义 |
| `/api/mcp` | MCP 接入，工具前缀为 `algorithmhot` |


[![Agent 接入说明：MCP、RSS 与 REST API 的使用入口。](docs/screenshots/2026-10-14/agent.png)](https://catl-21clab-sciagi.github.io/algorithmhot/agent/)

*Agent 接入说明：MCP、RSS 与 REST API 的使用入口。*

截图中的 localhost 地址来自当前站点配置；实际调用 API / MCP 时，应使用自己部署的完整站点地址，GitHub Pages 不提供这些后端服务。

可选的 [modules/pages-mirror](modules/pages-mirror/) 默认关闭。启用后，worker 默认每小时第 40 分钟抓取公开页面、去除脚本，并推送到配置的 `gh-pages` 分支，默认最多抓取 400 页。

镜像保留阅读页面和精选/全部的静态分类页；搜索、收藏、标签与未读等交互需要完整站点。API 和管理后台不镜像，镜像也不是数据库备份。查看后台运行记录中的页面数、跳过数、错误和推送提交，才能判断某次发布结果；源码提交成功与镜像发布成功是两件事。

## 开发与检查

```bash
npm ci
npm run typecheck
npm run test:standalone
npm run build -w @aihot/web
npx playwright install chromium webkit
node --test apps/web/tests/*.test.ts

# 替换测试密码；使用专用测试库，账户需要建库权限。
DATABASE_URL='postgres://postgres:replace-with-test-password@127.0.0.1:5432/algorithmhot_test' npm test

# 站点已启动后，只读检查页面与公开接口；按实际端口调整。
node scripts/smoke.ts --base http://localhost:3000
```

测试数据库名称必须以 `_test` 或 `_ci` 结尾。测试框架会迁移测试库，并为各测试文件创建独立副本。备份测试还需要与 PostgreSQL 17 匹配的 `pg_dump`、`pg_restore`；网页测试需要对应版本的 Playwright 浏览器。模型相关测试使用本机假服务。

```text
apps/web/              React Router 网页与阅读交互
apps/api/              HTTP、公开接口与管理后台 API
apps/worker/           pg-boss 任务与定时调度
packages/backend/     采集、模型回执、事件、报告与统一公开读取层
packages/contracts/   共享类型与协议
modules/research/     arXiv、Crossref、补采与论文配图
modules/pages-mirror/ 静态镜像抓取、改写与发布
industry/             信源、分类、筛选标准与提示词
site/                 站点身份、模型、品牌与页面配置
database/migrations/  数据库迁移
scripts/              初始化、迁移、本机运行与验收工具
```

## 当前边界

- **覆盖有上限**：默认来源有限，Crossref 当前按每本期刊首个 ISSN 查询、单次限量且不分页；缺失元数据、来源故障和过滤规则都会影响收录。空页面或未成刊不能直接解释为“没有新研究”。
- **摘要依赖材料**：多数论文从摘要和元数据进入流程，不能将生成内容称为全文审读或独立实验验证。筛选门槛仍需用标注样本校准，仓库不承诺筛选准确率。
- **配图按许可字段筛选**：异步尝试提取可用图片并记录来源；不保证每篇有图，也不等于逐图完成权属核验。缺图不阻断成刊。
- **运行能力与运行状态分开**：代码支持常驻服务、漏跑补偿和镜像发布；是否持续正常运行，以实际部署、请求回执和任务记录为准。

## 文档

| 文档 | 内容 |
| --- | --- |
| [AlgorithmHot 改造说明](docs/algorithmhot.md) | 从旧版到当前架构的背景与改动位置 |
| [部署指南](docs/deploy.md) | Docker、本机、HTTPS、备份与升级 |
| [本机运行](docs/local-daily.md) | 本机服务管理、状态检查与补刊 |
| [阿里云部署示例](docs/deploy-aliyun.md) | ECS、systemd 与镜像配置 |
| [架构](docs/architecture.md) | 模块划分、扩展点与迁移约定 |
| [筛选与校准](docs/selection.md) | 评分、入选规则与样本评测 |
| [站点配置](docs/customize.md) | `site/` 与 `industry/` 的配置方式 |

## 上游与许可

AlgorithmHot 基于 [KKKKhazix/AIHOT](https://github.com/KKKKhazix/AIHOT) 框架改造，当前重建版本以其 `652bd6b` 为基础，保留采集、评分、事件归组、公开读取层和管理能力，并加入本站科研配置与模块。内部 `@aihot/*` 包名保留。

代码采用 [MIT License](LICENSE)，原作者版权及第三方材料说明见 [NOTICE](NOTICE)。论文、图片和来源网站内容仍遵循各自许可。
