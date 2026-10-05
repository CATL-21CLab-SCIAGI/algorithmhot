# AlgorithmHot · 科研热点

公网阅读：[AlgorithmHot · 科研热点](https://pkucy2016.github.io/algorithmhot/) · [真实七天试刊](https://pkucy2016.github.io/algorithmhot/pilot/2026-10-03/) · [每日更新说明](docs/daily-delivery.md) · [公网验收](docs/public-delivery-acceptance.md)

项目统一保存在 [PKUCY2016/algorithmhot](https://github.com/PKUCY2016/algorithmhot)：`main` 是源码与迁移，`gh-pages` 是审计后的网页与公开数据。旧 `algorithmhot-source` 停止更新。新克隆不含本机数据库、账号登录、`.env` 或运行回执，初始化后从空数据库开始；现有日报可通过上方公网链接查看。同步范围与历史保留见 [源码同步说明](docs/source-backup.md)。


一个在本机使用的中文科研资料站，追踪**算法、AI4AI、AI4S**。优先解释方法变化、适用任务、作者报告的比较条件、公开实现与证据限制；社区热度只作为辅助信号。

本项目基于 [KKKKhazix/AIHOT 的固定提交 `3343fe2`](https://github.com/KKKKhazix/AIHOT/tree/3343fe2b20db4be7269113752d82d3992fc52b6b) 实现。沿用其五维评分、两次独立评分与原门槛，新增研究身份和日期、Codex CLI 传输、受限研究批次、试刊及本地运行管理。包名 `@aihot/*` 保留兼容，产品与公开工具标识使用 AlgorithmHot / `algorithmhot`。

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

进入站点可查看首页、三个栏目、资料详情、`/pilot` 试刊、`/daily` 日报、`/agent` 数据接入说明。后台 `/admin` 使用 `.env` 中的 `ADMIN_PASSWORD` 登录；不要把该文件或密码复制到公开文档。

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

## 批次、试刊与日报

```bash
# 首批或中断恢复均使用同一个 ID；all = 采集、处理、成刊。
npm run local -- run pilot-20261003-01 all

# 状态可在批次运行中查询，不发起模型请求。
npm run local -- run pilot-20261003-01 status

# 分阶段继续，也支持 collect / process / report / revise。
npm run local -- run pilot-20261003-01 process
npm run local -- run pilot-20261003-01 report

# 显式正常日报：刊期终点为指定日期北京时间 08:00。
npm run local -- daily 2026-10-03
```

首次创建试刊批次时冻结“启动时刻向前七天”的实际窗口，页面显示该窗口与试运行状态。正常日报窗口为前一天北京时间 08:00 至当天 08:00，历史回补需显式指定日期；试刊与日报分别存储和展示。

首批最多准入 **60 条去重研究候选**：算法 arXiv 20、物理材料 15、分子 15、机构博客合计 10；不足时按固定顺序补足。HF 不占正文准入名额。完整来源响应先保存，未准入资料保留为待处理，不计为模型拒绝。普通队列、补跑和 sweep 使用同一准入约束。

同一批次最多 **600 次应用模型调用**，全局并发为 1，其中预留 20 次供报告流程。探针、预筛、双评分、摘要、归组与报告均计入持久额度，重启不清零。每栏目最多刊载 5 条、全文最多 15 条，展示限制独立计数。相同窗口重跑保持幂等，`revise` 创建修订版本。

来源健康、处理完成而零入选时允许生成空刊；来源失败、额度不足、待处理或结果未知必须展示缺口。中断后先查看状态和回执，再按原 ID 恢复；不要删除回执或更换 ID 绕过额度。结果未知的已提交请求按研究身份隔离，不重发；其他未提交资料继续处理，已知失败也不自动重试。隔离跨日和修订保持；pending、登录及额度问题仍停止。

## 模型路线

默认使用 `LLM_TRANSPORT=codex_cli`，固定 `CODEX_BIN=/opt/homebrew/bin/codex`，初始模型为 `gpt-6-astra`、`medium`，复用该 CLI 的现有 ChatGPT 登录。每次处理使用独立上下文，保存输入哈希、提示词版本、模型、耗时、用量和结果状态，并校验结构化输出。可先自行运行 `/opt/homebrew/bin/codex login status` 核对登录；模型是否可用以实际调用回执为准。

保留 `LLM_TRANSPORT=openai_compatible`，显式设置 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 即可切换；参考 [配置示例](.env.example)。本轮 API 兼容验证使用本地模拟服务。Codex 登录失效或额度不足时保存检查点，**不会切换账户，也不会自动切换付费 API**。

当前公网自动化使用 `node scripts/daily-delivery.ts --refresh`，每3小时累计更新当天内容，共用当天60条准入/600次调用额度；固定08:00入口保留为兼容命令。详见[日内刷新说明](docs/daily-delivery.md)。

## 调度与停止

```bash
# 离线预览时钟，不采集、不调用模型。
node scripts/research-scheduler.ts --once

# 需要持续运行时才显式启用；交付时应关闭。
npm run local -- scheduler-start
npm run local -- scheduler-stop

# 只停止指定活动批次，保留网页、API 和数据库。
npm run local -- stop-batch pilot-20261003-01

# 停本项目进程；stop-all 另外停止专用数据库和 Colima，均保留数据。
npm run local -- stop
npm run local -- stop-all
```

可选调度在北京时间 08:00 执行正常日报，每六小时仅检查六条来源；同时到期时串行执行，启动不会追跑历史。普通 `start` 不启用调度。交付后保留网页、API 与数据库供查看，采集、模型批次和调度停止；该状态依赖本机进程存活。

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
| [研究元数据与数据出口](docs/research-api.md) | 研究日期、证据、试刊 API、RSS 与 MCP |
| [精选与校准](docs/selection.md) | 上游评分结构和后续人工校准方法 |
| [上游 README 存档](docs/upstream-readme.md) | 原框架背景、作者说明和通用部署文档 |

## 来源与许可

原框架作者为**数字生命卡兹克**，Copyright (c) 2026，代码采用 [MIT 许可证](LICENSE)，第三方素材说明见 [NOTICE](NOTICE)。AIHOT 名称和 Logo 不在上游 MIT 授权范围内，本项目采用 AlgorithmHot 品牌。来源文章、论文和代码各自保留原权利归属；本站链接或摘要不改变其许可。
