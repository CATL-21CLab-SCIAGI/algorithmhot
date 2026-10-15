# 部署到阿里云

通用步骤见 [部署](deploy.md)；这里只写 AlgorithmHot 在阿里云 ECS 上要注意的地方。

## 选地域：先确认模型能调通

模型走 AWS Bedrock 的 OpenAI 兼容接口。Bedrock 按调用方所在地区限制 OpenAI 和 Anthropic 的模型：2026-10-06 在受限地区调用时，返回 HTTP 400“当前国家、地区或属地无法访问”。服务器放在哪里，决定模型能不能用：

- **推荐：海外地域**（新加坡、日本、美国等）。模型、arXiv、Crossref 都直连，不用备案。
- **中国大陆地域**：网站对外要 ICP 备案（备案号填 `site/site.ts` 的 `icp`），而且 Bedrock 很可能拒绝。真要放大陆，worker 的模型请求要经过允许地区的出口代理。Node 24 的内置 fetch 设置 `NODE_USE_ENV_PROXY=1` 和 `HTTPS_PROXY` 后会走代理，写在 `docker-compose.override.yml` 的 worker 环境里。`EGRESS_PROXY_URL` 只管抓信源和图片，不管模型。

上线前在服务器上用一次极小的请求确认（把 key 换成自己的，花费可以忽略）：

```bash
curl -sS https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions \
  -H "Authorization: Bearer $LLM_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"global.openai.gpt-6-astra","messages":[{"role":"user","content":"Reply {\"ok\":true}"}],"max_completion_tokens":50}'
```

返回 200 才继续。

## 机器

2 核 4 GB 起（构建网页镜像要用到内存），系统盘 40 GB。装 Docker 和 Compose 插件。安全组放行 80、443；不用 Caddy 时放行 3000。

## 安装

```bash
sudo mkdir -p /opt/algorithmhot && sudo chown $USER /opt/algorithmhot
git clone <本仓库地址> /opt/algorithmhot
cd /opt/algorithmhot
cp .env.example .env    # 填 ADMIN_PASSWORD、SESSION_SECRET、IMG_PROXY_SIGN_SECRET、POSTGRES_PASSWORD（openssl rand -hex 32）和 LLM_API_KEY
```

`.env` 里要改的：

```dotenv
SITE_URL=https://你的域名
SITE_DOMAIN=你的域名
PORT=127.0.0.1:3000
TRUST_PROXY=true
COLLECT_ENABLED=true
MODEL_CALLS_ENABLED=true
LLM_BUDGET_PER_DAY=6000          # 软上限，按预算调
RESEARCH_CROSSREF_MAILTO=你的邮箱
```

大陆地域构建时 npm 走镜像：`docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com`。

## 保活

```bash
docker compose --profile https up -d --build   # 第一次构建并启动
sudo cp deploy/systemd/algorithmhot.service /etc/systemd/system/
# 用 HTTPS 时，把单元里两行 docker compose 都加上 --profile https
sudo systemctl daemon-reload && sudo systemctl enable --now algorithmhot
```

容器崩溃时由 Docker 的 `restart: unless-stopped` 拉起；机器重启后 systemd 把整组服务带起来。worker 起来后，pg-boss 把停机期间错过的定时任务各补跑一次，日报从上次缺的那期开始补（每次最多 8 期）。

## GitHub Pages 镜像（可选）

主站上线后，在 `.env` 里打开镜像，公开页面每小时同步到 `https://catl-21clab-sciagi.github.io/algorithmhot/`：

```dotenv
PAGES_MIRROR_ENABLED=true
PAGES_MIRROR_PRIMARY_URL=https://你的域名
PAGES_MIRROR_REPO=https://github.com/CATL-21CLab-SCIAGI/algorithmhot.git
PAGES_MIRROR_TOKEN=只给这个仓库 contents:write 的 fine-grained token
```

镜像是去掉脚本的静态 HTML，搜索、筛选、收藏这些要脚本的功能只在主站可用。

## 迁移到另一台机器

数据都在两个 Docker 卷里：`algorithmhot_db`（PostgreSQL）和 `algorithmhot_data`（上传、缓存）。也可以按 [部署](deploy.md) 的备份一节，每天备份到阿里云 OSS（S3 兼容：`DB_BACKUP_STORE_DOMAIN=<桶>.oss-<地域>.aliyuncs.com`），在新机器上恢复后再启动。
