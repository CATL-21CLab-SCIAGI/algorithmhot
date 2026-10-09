# AlgorithmHot · 科研热点

公网阅读：[AlgorithmHot · 科研热点](https://catl-21clab-sciagi.github.io/algorithmhot/) · [科研日报](https://catl-21clab-sciagi.github.io/algorithmhot/daily/) · [科研周报](https://catl-21clab-sciagi.github.io/algorithmhot/weekly/) · [科研月报](https://catl-21clab-sciagi.github.io/algorithmhot/monthly/) · [每日更新说明](docs/daily-delivery.md) · [公网验收](docs/public-delivery-acceptance.md)

项目统一保存在 [CATL-21CLab-SCIAGI/algorithmhot](https://github.com/CATL-21CLab-SCIAGI/algorithmhot)：`main` 是源码与迁移，`gh-pages` 是审计后的网页与公开数据。旧 `algorithmhot-source` 停止更新。新克隆不含本机数据库、账号登录、`.env` 或运行回执，初始化后从空数据库开始；现有日报可通过上方公网链接查看。同步范围与历史保留见 [源码同步说明](docs/source-backup.md)。


一个在本机使用的中文科研资料站，追踪**算法、AI4AI、AI4S**。优先解释方法变化、适用任务、作者报告的比较条件、公开实现与证据限制；社区热度只作为辅助信号。

在本机网站打开 **Agent 接入 → 调研模型**，管理员可切换 GPT-6 Astra、GPT-6.1 Sol 等已登记配置。保存只影响新研究批次，正在处理或恢复的批次保留原模型和日预算；读页面及保存设置均不调用模型。Bedrock 选项显示配置和访问限制，密钥只在后端保存。GitHub Pages 是公开阅读快照，模型管理需回到本机网站操作。详见 [模型切换与 Bedrock 状态](docs/bedrock-migration-plan.md)。

本项目基于 [KKKKhazix/AIHOT 的固定提交 `3343fe2`](https://github.com/KKKKhazix/AIHOT/tree/3343fe2b20db4be7269113752d82d3992fc52b6b) 实现。沿用其五维评分、两次独立评分与原门槛，新增研究身份和日期、Codex CLI 传输、持久调用预算、原论文配图刊物及本地运行管理。包名 `@aihot/*` 保留兼容，产品与公开工具标识使用 AlgorithmHot / `algorithmhot`。

**本地实现验收见 [验收记录](docs/acceptance.md)，后续公网发布与原图更新见 [公网验收](docs/public-delivery-acceptance.md)。** 尚未验证连续七天运行或人工标注后的筛选准确率。评分尚未以用户标注集校准；站点摘要、作者实验报告、代码链接与独立复现分别呈现，链接存在不等于实验已复现。

## 本机启动

需要 Node.js **24.11 或更新版本**、npm、Docker CLI 和 Colima。PostgreSQL 17 使用专用 Colima profile `algorithmhot`（初始 2 核、4 GiB）；所有 Docker 操作显式指定 `colima-algorithmhot` context。以下命令在源码仓库根目录运行（原本地总项目的 `app/` 目录）。

```bash
npm ci
npm run local -- init
npm run local -- db
npm run local -- migrate
npm run build
npm run local -- start
npm run local -- status
```

`init` 生成私有 `.env`、随机本地密钥和数据库配置，保留已有文件；无需填写付费 API key。不要先把含空密钥的 `.env.example` 覆盖为 `.env`。配置示例用于对照和调整已生成配置。

`start` 只启动网页和 API，检查数据库健康，不启动 worker、采集、模型处理或调度。默认网页/API 为 `127.0.0.1:3100/3101`；端口占用时自动选空闲端口并同步站点地址。当前本机实测网页避让到 [127.0.0.1:3102](http://127.0.0.1:3102)，重复启动复用进程；后续以 `status` 打印的地址为准。

进入站点可查看首页、三个栏目、资料详情、`/daily` 日报、`/weekly` 周报、`/monthly` 月报与 `/agent` 数据接入说明。历史试刊保留在本机，公开导航及静态导出不再提供试刊；本机旧 `/pilot` 入口转到日报。后台 `/admin` 使用 `.env` 中的 `ADMIN_PASSWORD` 登录；不要把该文件或密码复制到公开文档。

## 研究来源与内容范围

| 来源 | 用途 |
| --- | --- |
| arXiv `cs.LG + cs.AI` | 算法与 AI 方法 |
| arXiv `physics.comp-ph + cond-mat.mtrl-sci` | 计算物理与材料，仍需判断是否属于 AI4S |
| arXiv `q-bio.BM + q-bio.QM` | 分子生物物理与定量方法 |
| Hugging Face Daily Papers | 独立的社区入选信号，关联论文身份 |
| Google DeepMind | 机构研究发布 |
| Berkeley BAIR | 研究解释与补充 |

六条来源默认 `enabled=false`，配置固定六小时间隔；显式批次按来源 ID 采集。首期通过 arXiv 官方元数据接口分页补取窗口内资料，并保存来源响应、分页与截断信息。无文章、来源失败、未准入、模型拒绝分别计数。

一项工作只有一个主栏目，交叉主题用标签表示，优先级为 AI4S → AI4AI → 算法。原始发表、修订、社区入选、本站观测日期分别保存；未知日期不互相填补。只读到摘要时明确标为“基于摘要”，公开页面提供摘要与原文入口。

## 每日三次更新与图文刊物

北京时间每天 **09:00、15:00、21:00** 使用同一串联入口：

```bash
# 处理当前到期时段，随后成刊、导出、发布并核验。
node scripts/daily-delivery.ts --refresh

# 只读查看当前时段；恢复已有失败时段时使用回执中的完整 slot。
node scripts/daily-delivery.ts --refresh --status
node scripts/daily-delivery.ts --slot 2026-10-08-09 --status
node scripts/daily-delivery.ts --slot 2026-10-08-09 --resume
```

新时段采用 `all-in-window`：窗口内符合条件的去重研究候选全部准入，取消每日 60 条及分来源名额；HF 继续作为独立社区信号。来源原始响应、窗口外记录、待处理、拒绝与失败分别保存。研究按来源的原始发表时间归入日、周、月窗口；arXiv 使用 `originalPublishedAt` 原始提交时间，未知时保留未知。官方公告日、修订、社区入选与本站观测时间分别保留，不替代原始发表时间。

三次更新共用当天 `daily-YYYY-MM-DD` 的 **600 次应用模型调用**硬上限。09:00 研究处理累计至多 **290 次**，15:00 累计至多 **435 次**，21:00 累计至多 **580 次**，保留 20 次报告额度；这些都是当天累计上限，不是每次可额外调用的次数。全局并发仍为 1，重启和修订不清零。已冻结批次沿用原窗口、准入规则与调用上限，不因新增 15:00 时段而改写。候选全部准入不代表全部完成模型处理，未完成量保留在私有回执。新请求的 UNKNOWN 按研究身份隔离且占用次数，不自动重发；pending、登录及账户额度问题仍停止模型提交。

日报按原始发表日期汇总该日已通过筛选、公开可用且具备研究解读的成果；每栏目最多 5 条。周报在周一 09:00 整理上一自然周，每栏目最多 8 条；月报在每月 1 日 09:00 整理上月，每栏目最多 12 条。刊载上限只控制阅读篇幅，与候选准入和模型预算分开。

日、周、月刊的每篇文章均需绑定该资料版本的原论文配图，并保留图号、原图说明、作者归属、来源与许可。缺图、许可无法确认或待人工核对的资料暂不进入图文刊物；不会以方法示意图替代原图。成刊只整理已确认材料，不再调用模型写导语。正文展示方法、任务、比较条件与科学证据限制，运行回执和处理缺口保留在本机管理材料中。历史试刊及原始失败证据不改写。

当前机制、恢复边界与历史记录见 [每日更新说明](docs/daily-delivery.md)。脚本不会安装定时器；自动化是否启用、报告是否已公开，须以实际配置与发布回执确认。

## 模型路线

默认使用 `LLM_TRANSPORT=codex_cli`，固定 `CODEX_BIN=/opt/homebrew/bin/codex`，初始模型为 `gpt-6-astra`、`medium`，复用该 CLI 的现有 ChatGPT 登录。每次处理使用独立上下文，保存输入哈希、提示词版本、模型、耗时、用量和结果状态，并校验结构化输出。可先自行运行 `/opt/homebrew/bin/codex login status` 核对登录；模型是否可用以实际调用回执为准。

保留 `LLM_TRANSPORT=openai_compatible`，显式设置 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 即可切换；参考 [配置示例](.env.example)。本轮 API 兼容验证使用本地模拟服务。Codex 登录失效或额度不足时保存检查点，**不会切换账户，也不会自动切换付费 API**。

新建批次冻结本机已保存的模型配置；2026-10-07 的设置记录为 Codex GPT-6 Astra Ultra，恢复历史批次仍沿用各自原配置。每日更新成刊后的导出、发布或公网核验失败，同一时段最多自动恢复一次；恢复使用原回执，不重新提交已完成或结果未知的模型请求。

## 调度与停止

唯一日常自动生产者为 Codex heartbeat `algorithmhot`，计划在北京时间 09:00、15:00、21:00 运行上述入口。Mac 需开机、联网且 Codex 可调度；不会逐期追跑离线时错过的任务。旧产品 scheduler 保持停止，避免重复生产。启动阅读站点不会启动采集或模型。

```bash
# 查看进程，或停止旧产品 scheduler；暂停日常更新需在 Codex 暂停对应自动化。
node scripts/local.ts status
node scripts/local.ts scheduler-stop

# 仅停止明确的活动时段；保留网页、API、数据库与回执。
node scripts/local.ts stop-batch refresh-2026-10-08-09

# 停本项目进程；stop-all 另外停止专用数据库和 Colima，均保留数据。
node scripts/local.ts stop
node scripts/local.ts stop-all
```

历史 `run`、08:00 `daily` 与旧 scheduler 命令只用于明确的兼容或恢复任务，沿用历史冻结规则，不作为新的每日三次更新入口。完整说明见 [本地运行与恢复](docs/local-runtime.md)。

## 检查、证据与文档

```bash
# 新建隔离测试库，执行类型检查、数据库测试、网页构建与网页测试。
# 不使用真实模型，失败保留当次测试库供诊断。
npm run check
```

检查回执在 `.data/checks/<时间戳>/`；来源原始响应、候选清单与处理回执在 `.data/research/<批次 ID>/` 和数据库；本地进程、日志与调度回执在 `.data/local/`。这些运行数据与 `.env` 被 Git 忽略，不属于代码交付。页面与来源逐项核对、未入选样本检查及未校准项另记入验收记录，不能从自动化测试数量推导科研准确率。

| 文档 | 内容 |
| --- | --- |
| [本地运行与恢复](docs/local-runtime.md) | 完整命令、端口、进程隔离、调度、停止和恢复 |
| [实施计划](docs/implementation-plan.md) | 本轮边界与必需验收条件 |
| [验收记录](docs/acceptance.md) | 实测结果、完整分母、证据位置与剩余限制 |
| [研究元数据与数据出口](docs/research-api.md) | 研究日期、证据、报告 API、RSS 与 MCP |
| [精选与校准](docs/selection.md) | 上游评分结构和后续人工校准方法 |
| [上游 README 存档](docs/upstream-readme.md) | 原框架背景、作者说明和通用部署文档 |

## 来源与许可

原框架作者为**数字生命卡兹克**，Copyright (c) 2026，代码采用 [MIT 许可证](LICENSE)，第三方素材说明见 [NOTICE](NOTICE)。AIHOT 名称和 Logo 不在上游 MIT 授权范围内，本项目采用 AlgorithmHot 品牌。来源文章、论文和代码各自保留原权利归属；本站链接或摘要不改变其许可。
