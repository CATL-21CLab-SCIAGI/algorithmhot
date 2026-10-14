# 在本机固定运行（不用 Docker Compose）

服务器还没准备好时，网站可以在这台 Mac 上常驻运行：数据库在本机的一个容器里，api、web、worker 是三个常驻进程。所有定时的事（采集、模型判断、出日报、取配图、Pages 镜像）都由 worker 自己按时做（pg-boss，错过的补一次），**不依赖任何人或代理去触发**。每天的定时任务只做一件事：确认这几个进程还在，不在就拉起来，然后报告状态。

## 一条命令

```bash
npm run local:daily     # 等于 up，再等一分钟让刚起的 worker 补跑，然后 status
npm run local:up        # 数据库就绪、迁移，没在跑的进程拉起来（已在跑的不动）
npm run local:status    # JSON：进程、今天的日报、各定时任务最近一次、出问题的信源、模型用量；有问题时退出码 1
npm run local:down      # 停下（worker 有 210 秒收尾正在进行的付费请求）
```

脚本是 `scripts/local-stack.ts`，只读 `.env`，不改代码和配置。日志在 `.data/local/logs/`，进程号在 `.data/local/*.pid`。网站在 `SITE_URL`（本机默认 http://localhost:3300）。

`status` 认为有问题的情况：某个进程没在跑；北京时间 13:00 以后还没有今天的日报；有信源连续失败（`failing`）；最近一小时模型调用都没有得到回答；`.env` 里的 `HTTPS_PROXY` 连不上（模型请求走它）。

## 补出缺的日报

定时任务只补第一期日报之后缺的期。站点第一期之前的日子要出刊，等那几天的资料判断完以后跑一次（只写还不存在的期，已出的期不会动）：

```bash
npm run reports:daily -- 2026-10-10 2026-10-11
```

补采站点开始之前的论文（arXiv 某几天的公告、某天以来首次在线的期刊），按“上线时就被发现”入库，再由 worker 照常判断：

```bash
npm run research:backfill -- 2026-10-09 2026-10-12
```

补采把论文放进了已出刊的那几期时，等判断完（`status` 里 `work.waiting` 为 0）后明确替换那几期，被替换的版本保留在修订记录里：

```bash
npm run reports:daily -- --replace 2026-10-09 2026-10-10 2026-10-11 2026-10-12
```

## `.env` 里本机专用的几项

| 变量 | 作用 |
| --- | --- |
| `LOCAL_DOCKER_BIN`、`LOCAL_COLIMA_BIN` | docker、colima 的绝对路径（定时任务的 PATH 可能很短） |
| `LOCAL_DOCKER_HOST` | Docker 的 socket，例如 colima 的 `unix:///Users/<你>/.colima/algorithmhot/docker.sock` |
| `LOCAL_COLIMA_PROFILE` | Docker 连不上时先 `colima start` 这个 profile |
| `LOCAL_DB_CONTAINER`、`LOCAL_DB_VOLUME`、`LOCAL_DB_PORT`、`LOCAL_DB_IMAGE` | 数据库容器（默认 `algorithmhot-db-local`，端口 55434）；`DATABASE_URL` 要指向它 |
| `LOCAL_DAILY_SETTLE_SECONDS` | `daily` 在 `up` 后等多久再报告（默认 60） |
| `HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY` | 本机要走代理才能访问的服务（worker 的模型请求会用它）；`NO_PROXY` 要包含 `localhost,127.0.0.1` |
| `EGRESS_PROXY_URL` | 采集信源和图片走的代理 |

## 交给 Codex 的定时任务

在 Codex 里建一个每天运行的定时任务，比如北京时间 12:30（日报最迟 12:00 出刊，之后检查）。提示词原样用下面这段，**不要让它改代码**：

```text
你是 AlgorithmHot 本机运行的值守员，只检查和报告，不修代码。

在 /Users/yuchen/3. Project/复刻AIHot项目-AlgorithmHot/algorithmhot 目录运行这一条命令，不做别的：

  npm run local:daily

它会把没在跑的进程（api、web、worker）拉起来，然后输出一段 JSON。请：
1. 把 JSON 原样贴出来。
2. 用中文三五句话说明：三个进程是否都在跑；今天的日报是否已出、有几条；模型调用最近一小时是否正常（calls.attempts / calls.answered）；还有多少篇在等判断（work.waiting）；公网镜像最近一次推送（runs 里 pages-mirror.publish）是否成功。
3. 如果 ok 为 false，逐条列出 problems，并说明可能需要我做什么（例如“本机代理没开，请打开代理”“某个信源连续失败”），附上相关日志位置 .data/local/logs/。

规则：
- 不修改、不新建、不删除任何文件（包括代码、.env、数据库），不运行除上面这条以外的命令，不安装任何东西。
- 出了问题只报告，不要尝试修复，不要重启电脑或改系统设置。
- 如果命令因为权限被拒绝而失败（operation not permitted、无法连接 Docker 等），原样报告错误，并提醒我检查这个定时任务的权限设置。
- 不调用模型接口、不推送 git、不改这个定时任务本身。
```

这个定时任务要能在本机启动常驻进程、访问本机端口（3300、3301、55434）和网络。Codex 的沙盒如果不允许，就在这个定时任务的设置里给它完全访问权限。数据库在跑时脚本不碰 Docker，所以通常不需要 Docker 的权限；只有数据库容器停了，它才会去启动 colima / Docker。

Mac 睡眠时进程会暂停，醒来后 worker 把错过的定时任务各补一次；重启电脑后，下一次定时任务会把进程拉起来。要更早恢复，手动跑一次 `npm run local:up`。

## 换到服务器

服务器上用 `docker compose`（[部署](deploy.md)、[阿里云](deploy-aliyun.md)），不用这个脚本。数据从本机带过去：

```bash
docker exec algorithmhot-db-local pg_dump -U aihot -d aihot -Fc > algorithmhot.dump   # 本机
docker compose exec -T db pg_restore -U aihot -d aihot --clean --if-exists < algorithmhot.dump   # 服务器，先停 worker
```
