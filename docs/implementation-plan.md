# AlgorithmHot 首版本地实现计划

批准日期：2026-10-03。上游基线：3343fe2b20db4be7269113752d82d3992fc52b6b。

## Goal

实现算法、AI4AI、AI4S 三栏目研究站，接入六条真实来源，以现有 Codex 登录执行筛选和摘要，同时保留 OpenAI 兼容 API。保存完整来源响应，首批最多 60 条研究候选、600 次应用模型调用，生成明确标注最近七天窗口的试刊；通过类型检查、隔离数据库测试、构建、页面和端到端验收。完成后保留网页/API/数据库，停止采集及模型任务。连续七天运行、公开部署和人工标注准确率不属于本轮验收。

## 已确定产品规则

- 品牌 AlgorithmHot · 科研热点；中文界面；技术标识 algorithmhot。
- 主栏目 algorithm / ai4ai / ai4s；科学任务优先 AI4S，自动化 AI 研发其次 AI4AI，其余方法归算法；交叉主题用标签。
- 优先方法增量、适用任务、比较条件、可迁移实现与有信息量的负结果。社区热度辅助；保留原五维评分结构、两次评分、原门槛，标注未经过用户金标准校准。
- 来源：arXiv cs.LG+cs.AI、physics.comp-ph+cond-mat.mtrl-sci、q-bio.BM+q-bio.QM；HF Daily Papers hot_signal；DeepMind 和 BAIR editorial。固定每六小时检查，按需启用；全文展示和全文分发关闭。
- 论文、修订、社区精选、观测时间分别保存；未知保持空值；摘要与正文、作者报告与独立复现分别表述。

## 阶段与责任

1. 环境：本机 Node，专用 Colima algorithmhot（2 核 / 4 GiB）运行 PostgreSQL 17；主库/测试库隔离。API/web 127.0.0.1:3101/3100，冲突则同步改端口与 SITE_URL。
2. 模型：LLM_TRANSPORT=codex_cli / openai_compatible；本机 /opt/homebrew/bin/codex，gpt-6-astra medium，独立上下文与结构校验；保留回执/原始结果/用量。持久总上限600、并发1、预留报告额度；未知结果不自动重发，不切账户、不自动付费降级。
3. 数据：research 元数据贯穿 Candidate/MaterialInput/articles/publications/public API；增量迁移。arXiv abs/pdf/version关联，HF保留独立信号身份通过canonicalKey关联正文；固定来源节奏。
4. 批次：冻结七天窗口，保存响应和全部可解析metadata，然后在分析准入层限制60条；算法20、物理材料15、分子15、博客10，不足按确定顺序补足。所有队列、直接处理、sweep共享准入规则。记录重复、窗口外、未准入、失败、未知、待处理。
5. 报告/UI：真实七天试刊允许首次回灌；正常日报按前日 09:00（含）至当日 09:00（不含，Asia/Shanghai）筛选，并要求研究论文的原始提交时间落在该窗口。每节最多5条、总15条；健康空刊与未完成/源失败区分；同窗幂等、修订可追溯；不改写历史日期。
6. 验收：typecheck、隔离DB测试、web build与web tests、smoke、实际页面；真实Codex预筛/评分/摘要；六来源状态与批次回执；逐条检查刊载原文，检查至少10条未选（不足则全部），不称人工金标准评测。

模型层子任务独占0042迁移与providers/operations-recover；metadata子任务独占0043迁移、sources/content-materials/publication/contracts；行业子任务独占industry。主代理负责0044迁移、research批次、jobs准入、report composer、运行脚本、UI整合和全套验收。

## 恢复与结束

网络有界重试；权限拒绝、空源、解析失败分开。模型提交结果未知先查回执，已确认未提交可重试。单条失败不阻止独立资料处理；鉴权或额度阻塞时保存检查点，继续离线工作。共享测试库全套检查由主代理串行执行。未知/失败不算成功，未满足必需验收不完成goal。

最终提供启动、停止、批次运行/恢复、状态命令；worker和采集停止，网页/API/数据库保留。认证、原始运行数据、日志保存在.gitignore目录，密钥不进交付文档。
