# AlgorithmHot：在上游上翻新（2026-10-12）

AlgorithmHot（科研热点：算法、AI4AI、AI4S、电池与新能源材料）这一版直接建立在上游 [KKKKhazix/AIHOT](https://github.com/KKKKhazix/AIHOT) `652bd6b` 上。旧版本（上游 `3343fe2` 加大量未提交改动）整体放弃，原样存放在仓库外的 `_deprecated/v1-20261012/`，供对比。

## 旧版本的问题（逐条核对）

| 问题 | 核对结论 | 旧版本证据（`_deprecated/v1-20261012/app`） |
| --- | --- | --- |
| 生产依赖 Codex 自动化与桌面会话，不是常驻进程 | 属实 | 上游 pg-boss 定时任务从未启动：`scripts/local.ts` 只起 api、web、scheduler，没有 worker；09/15/21 时段由 Codex heartbeat 调 `scripts/daily-delivery.ts --refresh` 触发（该文件第 1 行注明“不安装调度器”），错过的时段不补跑；`codex_desktop_session` 传输要有活着的会话来领请求 |
| 模型调用不能无人值守 | 属实 | `.env` 为 `LLM_TRANSPORT=codex_desktop_session`；`codex_cli` 强制 ChatGPT 登录；`providers/bedrock.ts` 已接入但默认不选，10/06 探测被地域拒绝 |
| 预算写死在校验里 | 属实 | 迁移里有 `CHECK (max_calls BETWEEN 1 AND 600)`、`290/435/580`、材料 `=60` 等约束；`model-runs.ts` 要求 `maxCalls === 600`、`reportReserve === 20`；环境变量只能调低 |
| 日期规则多套 | 属实 | `original-publication` / `source-event` / `source-online` 三种冻结策略，另有 `original-publication-09-to-09-v1`；窗口有 09→09 与自然日两种；迟到论文会重写旧期（`revise:true`，修订号递增） |
| 发布门槛扣住整期 | 部分属实 | 选文本身不因缺图剔除；但导出时缺原图、许可不明、哈希不符会抛错，`daily-delivery.ts` 把这类错误记为 hold，整次公开交付停住，直到人工 `--resume` |
| 本机渲染→导出→推送→逐字节核对 | 属实 | `static-site.ts` → `publish-pages.ts`（推 `CATL-21CLab-SCIAGI/algorithmhot` 的 gh-pages）→ `daily-delivery/verify.ts` 逐文件比对 sha256 |

## 新版本怎么做

**运行时**：恢复上游的常驻进程方案。`docker compose` 跑 `db`、`api`、`worker`、`web`（可选 `caddy`）；所有定时任务由 worker 里的 pg-boss 调度，**漏跑补一次**（`missed: "once"`）是全部定时任务的默认值（`apps/worker/src/schedules.ts`）：服务器重启或停机后回来，每个错过的定时任务补跑一次。云服务器上用 Docker 的 `restart: unless-stopped` 加 systemd 单元（`deploy/systemd/algorithmhot.service`）保活。没有 Codex、桌面会话或本机脚本参与生产。

**模型**：走 OpenAI 兼容接口（上游的 `default` 模型），指向 AWS Bedrock 的 OpenAI 兼容端点 `https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1`，模型 `global.openai.gpt-6-astra`，密钥是 Bedrock API key。文献初筛、评分、解读这些审核步骤（以及其余写作步骤）默认都用它，单步可用 `*_MODEL` 改。2026-10-12 用本机凭据做过一次极小的真实调用（HTTP 200，29 tokens）。`LLM_REASONING_API=true` 让请求用推理模型的格式（`max_completion_tokens`、不带 `temperature`），和那次成功的调用一致。

**预算**：软上限，可配置。`LLM_BUDGET_PER_MINUTE/_PER_HOUR/_PER_DAY` 在 worker 启动时写进 `budgets` 表（不填就用后台“设置”里的值）。到上限时新的判断暂停，窗口过去自动接着做，不会让哪一期失败；日报周报月报的写作（`report_*`）不受每日上限限制。没有任何写死在迁移或校验里的数字。

**日期：一条规则，按来源上线日**（`content/materials.ts` 的 `decideTimeline`）：

- 每条资料放在来源把它放上网的时刻，但不晚于本站发现它的时刻。
- arXiv：公告日北京时间 08:00（读 `arxiv.org/list/<分类>/new`，标题行给出公告日；arXiv 的 RSS 要到美东午夜才换天，赶不上早上的日报）。
- 期刊：Crossref 的 `published-online`（首次在线日期）。只有日期没有时刻：当天发现的用发现时刻，之后才发现的放在那一天的最后一刻（北京时间 23:59:59），仍算那一天；Crossref 没登记首次在线日期时用本站发现时间兜底。
- 博客等其他信源：信源给的发布时间。拿不到日期的普通网页沿用上游规则，先不公开，读到日期再判断。
- 发现时已经过去 48 小时的仍按上游规则归档，不进“今天”、不进日报。

**日报窗口**：学 aihot，日报 D 收录上线时刻在（D−1 日 08:00，D 日 08:00］内的条目，08:00 这一分钟算在当天（arXiv 公告正落在这一分钟）。工作日早上，日报等当天的 arXiv 公告读到、窗口内的资料判断完再出刊；最迟 12:00（`EDITION_TIMES.dailyDeadline`）照常出刊，判断不完的只在时间线上出现。**已出刊的旧期不再重写**：定时任务只写缺的期，不改已有的。

**发布门槛降为提示**：论文条目带一行注记（arXiv 号、公告日或首次在线日、许可、PDF），没有核实过的原图就标“配图 待补”。注记只是提示，不影响选文和出刊，任何一期都不会因为图片或许可被扣住。注记由采集时写进资料（`raw.notes`），经公开读取层（`publication/items.ts` 的 `itemNotes`）出现在卡片、详情页和日报条目上。

**网站部署在云上**：云服务器直接运行网站（见 [阿里云部署](deploy-aliyun.md)）。GitHub Pages 只做只读镜像：`modules/pages-mirror` 每小时由 worker 把公开页面抓成静态 HTML（去掉脚本，链接改到 `/algorithmhot/` 子路径），推到 `CATL-21CLab-SCIAGI/algorithmhot` 的 gh-pages。镜像失败只记在运行记录里，不影响主站，也没有逐字节核对。默认关闭（`PAGES_MIRROR_ENABLED`）。

## 对框架的改动

只在必须的地方动框架，其余放在 `site/`、`industry/` 和两个模块里，方便以后合并上游：

| 位置 | 改动 |
| --- | --- |
| `packages/backend/src/content/materials.ts` | 时间线按来源上线时刻（不晚于发现时刻）；`publishedAtDay` 表示只有日期 |
| `packages/backend/src/reports/edition.ts` | 窗口改为（start, end］，只按时间线归属，不再看放行时间 |
| `packages/backend/src/reports/compose.ts` | `dailyHold`：窗口内还在判断、或模块说还要等时，截止前先不出刊；等待不算失败 |
| `packages/backend/src/modules.ts` | 新插口 `reports.dailyHold`；`missed` 默认 `once` |
| `packages/backend/src/providers/receipts.ts` | `applyBudgetEnv`；`report_*` 不受每日上限 |
| `packages/backend/src/providers/llm.ts` | `LLM_REASONING_API` |
| `packages/backend/src/operations/alerts.ts` | 日报超时按截止时间加 1 小时算 |
| `packages/contracts/src/site.ts`、`publication/items.ts`、`publication/reports.ts`、网页 `ItemNotes` | 资料注记 |
| `industry/taxonomy.ts` + `reports/edition.ts` | `UNCATEGORIZED_CATEGORY`：没归类的进“算法”一节 |
| `site/site.ts` + `reports/edition.ts` | `DAILY_SIZE`：日报篇幅（20 条、快讯 20 条、同一信源最多 8 条），上游写死为 12 / 10 / 2，不适合信源少、论文多的站 |
| `scripts/local-stack.ts`、`scripts/compose-daily.ts` | 本机常驻运行与补出第一期之前的日报（[本机固定运行](local-daily.md)） |

## 模块

- `modules/research`：arXiv 三组分类、六本期刊（Nature、Nature Energy、Nature Materials、Science、Angewandte、JACS），配置在 `industry/research-feeds.json`。每个来源是一行 `external` 信源，后台可暂停；采集记 `fetch_runs` 和信源健康度。arXiv 请求间隔 3.1 秒。
  配图（`modules/research/figures.ts`，每 20 分钟一次）：只给已入选的论文找图，而且只在许可允许转载时（CC BY、CC BY-SA、CC0）才附：arXiv 看摘要页的许可，取 HTML 版的第一张图；期刊看 Crossref 登记的许可，取出版社页面声明的图（og:image）。找到就存进资料（`raw.figure`），连同出处和许可显示在卡片、详情页和日报条目上；找不到或许可不允许，就标“配图 待补”并写明原因。它不参与采集、判断和出刊，失败只影响配图。
- `modules/pages-mirror`：GitHub Pages 只读镜像。

本机常驻运行（服务器准备好之前）见 [本机固定运行](local-daily.md)。

## 还没做的

- **旧数据**：新版本从空库开始，没有导入旧版本的论文和日报。旧库仍在 colima `algorithmhot` 的 `algorithmhot-db` 容器里（127.0.0.1:55432）。
- **门槛**：沿用上游（T1 60、T1_5 65、T2 76）；按 `docs/selection.md` 用标注样本重新校准之前不要凭感觉改。
- **条款与隐私页**（`site/pages/`）的运营主体待确认。
