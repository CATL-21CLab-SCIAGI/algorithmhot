# 源码同步与仓库历史

项目统一使用公开仓库 [CATL-21CLab-SCIAGI/algorithmhot](https://github.com/CATL-21CLab-SCIAGI/algorithmhot)。`main` 保存可运行源码；`gh-pages` 保存经过清单与内容审核的阅读快照。网页地址为 [AlgorithmHot 科研热点](https://catl-21clab-sciagi.github.io/algorithmhot/)。旧 `algorithmhot-source` 停止更新，不再作为同步目标。

2026-10-05 合并前核对发现两仓库均为 Public；此前说明将源码仓库称为 Private 不符合当时实际设置。本次依据用户的合并要求修正。源码同步不会上传任何本机秘密或运行数据。

## 内容范围

保存源码、锁文件、配置示例、数据库增量迁移、测试、品牌与已审核原图资产、使用说明及验收摘要。AIHOT 基线为 `3343fe2b20db4be7269113752d82d3992fc52b6b`，保留 LICENSE 与 NOTICE。

不保存 `.env`、`.data/`、依赖目录、构建产物、数据库内容、原始来源响应、模型回执、账号登录或密钥。`SOURCE_SNAPSHOT.json` 记录本次源码文件清单与 SHA-256（不包含清单自身）。数据库结构由 `database/migrations/` 重建；源码同步不是数据库备份。

合并保留旧源码提交 `a256b5869fdd81f850477a42e5237edc1dad8ded` 和既有网页提交历史，通过普通合并提交衔接，不强推覆盖历史。本机另保留两份 Git bundle 用于恢复。网页发布器严格绑定 `gh-pages`，逐文件验证导出清单；不能覆盖 `main` 源码。

CI 定义保留，但仅允许手动 `workflow_dispatch`，避免源码同步自动新增云端计算任务。GitHub Pages 继续使用其既有分支部署。

## 新机器运行

克隆 `algorithmhot` 默认 `main` 分支，在根目录按 README 执行。`npm ci` 使用锁文件；`local init` 生成本机配置；`local db` 与 `local migrate` 建立空数据库；普通 `local start` 只启动阅读服务，不采集或调用模型。

研究批次需要在该机器自行完成 Codex 登录并设置 `CODEX_BIN`。不要复制另一机器的登录文件。自动化不随 Git 克隆迁移，应按 `docs/daily-delivery.md` 在有权限的机器单独配置；生产者保持唯一。

## 验证边界

按 README 执行 `npm run check`，使用隔离测试库验证类型、后端、网页和构建；再核对运行站点的 smoke、源码快照清单、远端提交与 Pages 部署。检查通过不代表科研结论已独立复现，实际报告继续保留 PARTIAL 和 UNKNOWN。
