# AlgorithmHot 本地运行

本地模式使用 Node 运行 API、网页和批次，PostgreSQL 17 运行在专用 Colima profile `algorithmhot`。所有 Docker 命令显式使用 `colima-algorithmhot` context；不会切换默认 context。运行配置、凭据、PID、日志与调度回执位于被 Git 忽略的 `.env`、`.data/`。

## 首次准备与阅读站点

在源码仓库根目录执行（原本地总项目的 `app/` 目录）：

```bash
npm ci
node scripts/local.ts init
node scripts/local.ts db
node scripts/local.ts migrate
npm run build -w @aihot/web
node scripts/local.ts start
node scripts/local.ts status
```

`init` 保留已有配置，只创建缺失的本地私密配置文件，不输出凭据。`db` 启动专用 profile（首次按 2 CPU、4 GiB 内存配置）和 `algorithmhot-db`，随后检查数据库健康；不删除已有卷。`migrate` 执行增量迁移并导入行业包，已有来源配置不会被覆盖。

网页默认地址是 `http://127.0.0.1:3100`，API 默认端口为 `3101`。`start` 先确认数据库健康，端口占用时在原端口起的 100 个端口范围内选择空闲端口，同时更新 `.env` 的 `WEB_PORT`、`API_PORT`、`SITE_URL` 和 `API_BASE_URL`。以命令打印的地址为准；两项服务只绑定本机回环地址。本轮已实测默认网页端口占用时避让至 `http://127.0.0.1:3102`，重复启动复用已有进程。

重复 `start` 复用本项目现有进程；连接地址变化时仅重启本项目 API 和网页，保证两者使用相同配置。普通 `start` 不启动 worker、采集、模型批次或定时调度。网页和 API 读取资料不会触发模型调用。

完成网页构建后，使用 `node scripts/local.ts restart-reading` 刷新网页/API 进程；该命令不停止或重新提交活动的模型批次。数据库迁移会拒绝在模型批次或调度活跃时运行，并在迁移前后重新建立阅读进程连接。

## 切换调研模型

在运行本项目的电脑上打开 [Agent 接入](http://127.0.0.1:3102/agent)，进入「调研模型」并登录管理员账号；端口若变化，以 `local.ts status` 显示的站点地址为准。选择 GPT-6 Astra 等预设并保存，只影响下一次新建调研批次；已有批次保留固定配置。阅读页面或保存选择均不会发起模型请求。

该控件仅在本机动态页面提供，公开静态阅读页不提供模型管理。面板区分 Codex 订阅与 AWS Bedrock 按量付费，并显示实际验证状态。截至 2026-10-06，当前 Bedrock GPT-6 Astra 路线因地域限制被拒绝，暂不可选；Codex 预设配置就绪不等于实际生成已验证。600 次调用上限不是美元费用上限。

## 每日三次更新与图文刊物

当前日常入口为 `daily-delivery.ts --refresh`，由 Codex heartbeat `algorithmhot` 在北京时间每天 **09:00、15:00、21:00** 触发。普通 `start` 不启动它；原产品 scheduler 保持停止，避免两个生产者并行。脚本执行与自动化是否启用分别核对，不把文档或启动网页当成已配置调度。

```bash
# 当前到期时段；完成研究处理后整理刊物、导出、发布并核验。
node scripts/daily-delivery.ts --refresh

# 只读查询；恢复须使用回执中已有的完整时段身份。
node scripts/daily-delivery.ts --refresh --status
node scripts/daily-delivery.ts --slot 2026-10-08-09 --status
node scripts/daily-delivery.ts --slot 2026-10-08-09 --resume
```

新建09、15、21点时段采用 `all-in-window`，取消每日 60 条及分来源名额，按来源与窗口条件对研究身份去重后全部准入。三个时段共享 `daily-YYYY-MM-DD` 的 600 次应用模型调用硬上限：09点累计至多 290 次，15点累计至多 435 次，21点累计至多 580 次，另保留 20 次报告额度。全量准入、完成处理与实际刊载是三个不同分母；达到处理上限后保留待处理状态。重启或同日修订不清零，UNKNOWN 保留占用并隔离，failed 不自动重发。

日报每栏目最多 5 条；周报在周一 09:00 整理上一自然周，每栏目最多 8 条；月报在每月 1 日 09:00 整理上个月，每栏目最多 12 条。图文刊物只使用已经公开、通过精选且有研究解读的材料，每条还必须通过原论文配图及资料版本绑定检查。缺图、许可待确认、需复核的资料保留在私有检查记录，不以生成式示意图替代。成刊不增加导语模型调用；周/月刊无合格条目时不保存空刊。

周期成刊由串联入口调用 `local.ts editions`，与研究批次共用项目批次锁，只使用既有材料。日常只处理最新到期刊期；历史周/月刊补建必须显式指定已关闭的刊期。2026-W40 与 2026-09 为本次明确补建范围，完成和上线以实际回执确认。

公开入口为 `/daily`、`/weekly`、`/monthly`。旧试刊保留本机历史证据，移出公开导航和静态导出，旧 `/pilot` 阅读路径转到日报。读者页面展示科研结论、依据和原图归属；批次、预算、处理状态等保留在私有运行材料。完整规则与历史变更见 [每日更新说明](daily-delivery.md)。

## 历史批次及 09:00 入口（仅兼容与恢复）

以下命令保留旧的冻结窗口、准入与预算，不代表现行早晚更新规则；不应使用新 ID 绕过既有回执。

```bash
# 稳定的批次 ID：恢复时继续使用原 ID，保留原始模型回执和调用额度。
node scripts/local.ts run pilot-20261003-01 all

# 分阶段调用：collect / process / report / revise / status
node scripts/local.ts run pilot-20261003-01 status

# 正常日报，日期指北京时间 09:00 的刊期终点。
node scripts/local.ts daily 2026-10-03

# 单独检查六条来源，保存采集结果；不启用模型，也不将来源设为 enabled。
node scripts/local.ts check-sources
```

`daily YYYY-MM-DD` 委托 `scripts/research-run.ts daily-YYYY-MM-DD all`，并传入 `RESEARCH_RUN_KIND=daily` 与 `RESEARCH_RUN_DATE`。日报窗口为前一天北京时间 09:00 至刊期当天 09:00；论文还必须以原始提交时间落入该窗口，公告或本站观测时间不替代原始提交时间。手动回补历史日报需要显式指定日期。

macOS 批次运行期间阻止空闲自动休眠，批次退出立即释放；不会阻止手动休眠或关机。断网或手动休眠仍可能留下 UNKNOWN 回执，应核对证据再恢复。

`run <id> status` 可在批次运行时并发查询，关闭模型与采集开关，不获取批次锁。所有执行模型的批次与来源检查共享 `.data/local/batch.lock`。同一时间只允许一个批次；冲突返回退出码 `75`，不提交第二个任务。活动批次 PID 和进程身份写入 `batch.process.json` / `batch.pid`，各次运行状态写入 `batch-<id>.json`。停止的批次可能留下结果未知的模型请求，应先检查模型回执，再使用原批次 ID 恢复；不要通过删除回执或更换 ID 强制重发。

## 旧产品 scheduler（保持停止）

```bash
# 只读预览下一次时间，不采集、不调用模型、不启动调度。
node scripts/research-scheduler.ts --once

# 当前只查看和停止旧 scheduler；不与 heartbeat 同时启用。
node scripts/local.ts scheduler-stop
node scripts/local.ts status
```

以下仅说明旧 scheduler 的兼容行为。当前日常更新使用上方 heartbeat，旧 scheduler 保持停止；显式启用旧 scheduler 时有两项工作：

- 北京时间每天 09:00 运行当期 `local.ts daily YYYY-MM-DD`。
- 每六小时串行检查六条来源。首次检查在首次启动调度的六小时后；重启可沿用尚未到期的检查时间。检查使用 `MODEL_CALLS_ENABLED=false`、空 `MODEL_RUN_ID` 和研究准入约束，保留来源的禁用状态，不进入模型处理队列。

如果两项工作同时到期，先运行日报，再执行来源检查。运行期间无第二个并发批次；遇到手动批次占用时只等待锁释放，每 30 秒检查一次，不会重复提交已经开始的模型任务。已提交任务失败或中断后不自动重试。

启动调度不会追跑停机期间的历史任务；旧 checkpoint 中的未开始任务记录为 `skipped-on-start`，旧活动任务记录为 `interrupted-unknown` 并留待检查。持续运行的进程因系统休眠错过多个时段时，只处理最近到期的一期和一次来源检查，不逐期回放。调度依赖本机保持运行，不是系统开机服务。

调度的下次时间、待执行列表和活动任务写入 `.data/local/scheduler.json`；追加回执在 `scheduler-receipts.jsonl`；每次来源检查的逐源结果在 `source-check-<id>.json`。`--once --now <ISO时间>` 可离线预览时间计算，只有 `--once` 允许指定时钟，不会执行任务。

## 停止与保留数据

```bash
# 只停止指定 ID 的活动时段；以当前回执中的实际 ID 为准。
node scripts/local.ts stop-batch refresh-2026-10-08-09

# 停止调度及其当前子任务，保留网页与数据库。
node scripts/local.ts scheduler-stop

# 停本项目调度、批次、网页和 API；数据库继续运行。
node scripts/local.ts stop

# 进一步停止专用数据库容器和专用 Colima profile；保留卷和本地文件。
node scripts/local.ts stop-all
```

停止前核对保存的 PID、启动时间与本项目入口，避免误停已复用 PID 的其他进程。停止使用 `SIGTERM`，等待最多十秒；未退出时明确报错并保留 PID，不升级成强制清除。重试 `status` 检查状态。

阅读服务交付时应能读网页、API 和数据库，旧 `scheduler: stopped`。`batch` 是否运行取决于当时早晚串联进度，应使用回执核对；停止阅读服务不等于暂停 Codex 自动化。运行 `scheduler-stop` 不会关闭网页；普通 `start` 也不会重新启用调度。

## 检查与恢复证据

```bash
# 旧兼容调度的纯离线时钟测试；现行早晚更新另见 daily-delivery 测试。
node --test tests/scheduler-clock.test.ts

# 完整离线验收：每次创建独立新测试库，模型只走本地 mock。
node scripts/check.ts

# 仅需单独准备测试数据库时可使用此命令。
node scripts/local.ts test-db

# 进程与调度概览，不打印数据库密码。
node scripts/local.ts status
```

完整验收结果写入 `.data/checks/<时间戳>/checks.json` 与分项日志；成功后清理当次测试库，失败时保留测试库与私有连接文件供诊断。完整验收应使用 `scripts/check.ts`，避免反复复用旧测试数据导致干扰。

日志分别是 `.data/local/api.log`、`web.log`、`scheduler.log`。批次的来源响应、候选清单和模型回执继续按研究流水线约定保存；生命周期回执只描述进程是否退出，不能代替来源完整性、模型完成状态或科研结论验收。不要将 `.env`、`postgres.env`、数据库卷、私有日志或账户凭据纳入代码交付。
