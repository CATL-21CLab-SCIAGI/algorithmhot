# 每日自动产刊与公网更新

本机承担采集、Codex 模型处理和报告生成，GitHub Pages 仅提供公开阅读快照。Mac 关机或断网时，已发布的网页继续可读；新增报告要等本机有执行机会。使用现有 Codex 登录，不新增托管服务，不自动切换账号或付费 API。

## 每日入口

在项目 `app/` 目录执行：

```bash
node scripts/daily-delivery.ts
```

默认按执行时刻选择**最近已关闭的北京时间 08:00 刊期**。例如 10 月 4 日 08:00 后执行，处理 10 月 3 日 08:00 至 10 月 4 日 08:00；10 月 4 日 07:59 执行仍选择 10 月 3 日刊期。长时间关机后，只处理最近一期，不循环补发历史日报。

执行顺序为：专用数据库就绪 → 本地网页/API 就绪 → 日报生成 → 公共静态导出 → GitHub 发布。任何阶段失败都会停止后续步骤。采集失败、模型额度不足或结果未知造成的 `partial` 报告可以发布，但保持原有缺口提示，不能称为“今日无研究”。健康空刊是有效报告。

脚本默认使用以下公开位置：

- 仓库：`PKUCY2016/algorithmhot`
- 网站：`https://pkucy2016.github.io/algorithmhot/`
- 静态导出目录：`.data/public-site`

`STATIC_SITE_REPO` 和 `STATIC_SITE_BASE` 可用于明确指定另一 GitHub Pages 项目地址，二者必须匹配。每期目标地址在回执里冻结；恢复同一期不能悄悄换仓库。导出从项目 `.env` 中读取 `SITE_URL`，仅接受无凭据的本机 HTTP 地址；不会将 `.env` 复制至公开文件。

## 调度方式

由当前 Codex 对话的每日 heartbeat 在北京时间 08:00 调用这一入口。脚本本身不安装定时器，不创建 `launchd` 项，也不常驻运行。Codex 应用/本机需要具备执行条件；账户额度、登录和上游网络仍可能阻止当日更新。没有运行记录就不能认为已经持续运行。

原有产品 scheduler 保持停止，避免两个自动生产者并行。启动网页不代表启动采集、模型或定时器。首次接入须另行确认 heartbeat 已配置成功；仅存在本文件并不意味着已启用自动更新。

每期使用稳定的 `daily-YYYY-MM-DD` 批次身份，沿用已有冻结准入与持久模型预算，每批最多 60 条候选、600 次应用模型调用。重复触发已完成的一天不会再次生成、导出或发布。模型全局并发及回执规则仍由既有处理层执行。

## 状态与恢复

```bash
# 只读查看最近到期刊期与串联回执，不启动服务、模型或发布。
node scripts/daily-delivery.ts --status

# 查看指定日期。
node scripts/daily-delivery.ts --date 2026-10-04 --status

# 先核对私有日志和回执，再明确恢复同一日期。
node scripts/daily-delivery.ts --date 2026-10-04 --resume

# 已成刊后更新样式/公开材料，仅重新导出和发布，不重新调用模型产刊。
node scripts/daily-delivery.ts --date 2026-10-04 --refresh-public
```

串联回执和分阶段日志保存在 `.data/daily-delivery/`，来源与模型回执仍保存在既有数据库及 `.data/research/daily-YYYY-MM-DD/`。这些文件不发布至 GitHub。

默认触发遇到未完成串联会停下，不自动重复模型处理。明确 `--resume` 后，成功产刊阶段会复用；导出成功、发布失败时，只重试发布，并重新确认本地服务可用。若进程在保存串联回执前已成刊，会通过数据库识别同一期既有报告并复用。不会自动调用 `revise`，也不会另造批次 ID。

产刊前只读核对模型执行锁与 pending 请求。有请求仍在途或提交结果尚未核对时停止；已有 `UNKNOWN` 回执不释放、不重发，处理层保留其缺口。登录失效或额度用完时保留状态，待账户条件恢复后人工/代理核对回执，再显式恢复。

单一项目锁同时保护当日生产和共享导出目录。异常退出留下锁时，先确认项目没有活动批次：

```bash
node scripts/local.ts status
node scripts/daily-delivery.ts --recover-lock
```

只有锁属主进程已死亡，且没有项目 batch/scheduler 活动时才归档旧锁；不杀死进程抢锁。此命令不会生成或发布。随后仍需查看回执并使用原日期 `--resume`。

## 停止

暂停每日更新应暂停 Codex heartbeat。若当日批次正在执行，使用其确定 ID 停止：

```bash
node scripts/local.ts stop-batch daily-2026-10-04
```

这会保留网页、API、数据库及既有公网快照。需要关闭本机整个项目时使用 `node scripts/local.ts stop-all`；数据和公网已发布内容仍保留。

## 验证范围

`tests/daily-delivery.test.ts` 使用临时目录和注入的假命令验证：08:00 边界、相同刊期重复调用、跨日/同日锁、产刊失败不发布、发布失败恢复、部分报告与未知结果保留、在途请求阻断、缺少持久报告阻断、显式公开刷新及锁恢复。测试不会采集、调用真实模型或连接 GitHub。真实发布、heartbeat 建立及公网访问状态以本次交付回执为准。


## 本次已启用状态（2026-10-04）

已创建并启用 Codex heartbeat `algorithmhot`（AlgorithmHot 每日科研日报），本机时区为北京时间，每日 08:00 **开始**采集/生成；完成后发布。通知策略为仅失败提醒。需要 Mac 开机、可执行、联网且 Codex 应用可调度；睡眠、离线、账号或上游故障会延迟更新。没有新增付费托管，也没有把 Codex 登录放进 GitHub。

真实串联 `daily-2026-10-04` 完成：复用已生成日报，导出并推送；一次凭据助手配置问题导致的发布失败已保留且仅重试发布。随后同日重触发返回 `already-delivered`，没有重新产刊或新增模型调用。公网 6 个主要出口的内容与本地已审计包逐字节一致，GitHub Pages 构建成功、HTTPS 已启用。

独立发布 checkout `.data/pages-repo` 仅存公开快照。本机 Git 直连曾超时，目前仅此仓库配置现有代理 `http://127.0.0.1:7877`；代理未运行时保留发布失败，不改全局代理或切换账户。凭据继续使用系统已安装的 osxkeychain 助手。

发布专用恢复命令（先读错误与状态）：

```bash
node scripts/publish-pages.ts --check
node scripts/publish-pages.ts --recover-lock
node scripts/publish-pages.ts --recover-stage
```

`--recover-lock` 仅归档已死亡进程的锁；`--recover-stage` 验证 HEAD、暂存区和文件均属于已审核生成清单后，才回退本脚本的复制中断，未知改动一律保留。commit 完成但登记 approved-heads 回执前崩溃时会保守阻断，须人工核对该提交内容后恢复；不能为了恢复直接放行未知提交历史。

验收见 [公网交付记录](public-delivery-acceptance.md)。暂停将来更新：在 Codex 自动化中暂停“AlgorithmHot 每日科研日报”；停止本机服务不会删除 GitHub 已有网页。
