# GitHub Pages 静态公开阅读版

公开地址：`https://pkucy2016.github.io/algorithmhot/`。项目统一在 `PKUCY2016/algorithmhot`：`main` 保存应用源码，`gh-pages` 只保存生成的公开网页和数据。网页发布分支不接收应用源码、数据库、原始响应、模型登录或调用回执。发布前须确认 [公开阅读版说明](public-reading-policy.md)，静态站的“来源与隐私说明”使用同样的七项内容。

## 导出

在本项目 `app/` 目录运行，先确保本机 API 和网页已启动。公网复用本地网页实际渲染的 AIHOT 布局与 CSS，不再维护另一套页面设计；修改网页源码后，应先构建并重启读取服务：

```bash
npm run build
node scripts/local.ts restart-reading
node scripts/static-site.ts

# 可显式指定本地公开接口、公开基址与输出目录
node scripts/static-site.ts \
  --api http://127.0.0.1:3101 \
  --web http://127.0.0.1:3102 \
  --base https://pkucy2016.github.io/algorithmhot/ \
  --output .data/public-site
```

公开内容清单来自本机 HTTP 的 `/api/site/` 出版读取接口。版式取自 `--web` 指向的本机已构建网页：保存现有侧栏、报告归档栏、刊头、文章双列和主题卡片，并净化脚本、动态接口地址和不支持的交互。导出脚本不导入数据库、模型模块或 `.env`，不发起模型调用，不直接读取数据库，不下载外部图片。每个模型结果仍需先通过正常发布层，才可能进入此快照。

输出提供：首页、18 个主题及其全部关联详情、研究资料详情、试刊、日报、归档、Agent 阅读说明、来源与隐私说明，以及 `data/snapshot.json`。所有内部链接、资源和规范网址带 `/algorithmhot/` 前缀。HTML 不需要 JavaScript；小图标和论文路线图均由本地 SVG 或语义化 HTML/CSS 绘制，手机端可阅读。

数据白名单保留公开摘要、解读、研究时间、来源入口和报告范围。来源正文 HTML、内部站点 URL、源图标代理、管理配置、模型提示词版本、私有回执等不进入输出。含本机地址、个人主目录或明显凭据模式的公开文本会使导出失败。HTTP 外链只接受不含凭据的公共域名，拒绝执行型 URL、IP 字面量与本地网域。

试刊配图使用 industry/paper-figures.ts 中逐篇核验的原始文献图，绑定条目与报告来源版本，展示原图号、中文说明、作者和许可链接。远端原图使用精确 URL 白名单，no-referrer，页面 CSP 仅允许实际用到的原图主机；PDF 提取的完整图区仅允许哈希、PNG 格式及尺寸匹配的已审查资源。图片可点击放大，仅放在试刊文章内，不改变其他页面布局，不重新调用模型。没有原图的资料明确说明，不用生成图替代。旧报告修订不能通过最新条目静默回填新研究结论；内容修订仍需沿用正常报告修订流程。

## 安全清单与原子替换

每次输出包含 `export-manifest.json`：

```json
{
  "schemaVersion": 1,
  "publicBaseUrl": "https://pkucy2016.github.io/algorithmhot/",
  "generatedAt": "ISO 时间",
  "files": [{ "path": "index.html", "sha256": "文件 SHA-256", "bytes": 123 }]
}
```

清单包含所有生成文件（包括 `.nojekyll`），不包含清单本身。发布端应验证目录与清单完全一致、字节数和哈希一致、没有符号链接或额外文件。失败时不替换线上内容。

导出先在相邻暂存目录完成，再原子替换有合法旧清单的输出目录；不覆盖无清单目录，不跟随符号链接，不删除旧目录中新增的未登记文件。公开读取失败、主题分页变化、重复游标或报告索引触及 400 期上限均会停止导出，保留旧包，不静默缩小范围。

## Pages 配置

使用同一仓库 `PKUCY2016/algorithmhot` 的 `gh-pages` 分支根目录发布：`Settings → Pages → Deploy from a branch → gh-pages / (root)`。无需构建工作流；实际导出目录不包含 `.github/workflows`，避免要求额外的 workflow 权限。`.nojekyll` 保证 Pages 原样托管静态文件。发布程序严格绑定 `gh-pages`，不能覆盖保存源码的 `main`。旧发布 checkout 的 `main` 与缺少分支信息的状态文件必须经核对后迁移，不能直接重新注册绕过检查。

同事访问的是已发布快照，本机停机不会删除已有报告。生成新内容和推送更新仍依赖本机采集、模型处理和日报发布链路；静态站不提供实时 MCP 或动态搜索 API。

## 验证

```bash
node --test tests/static-site.test.ts
node --test tests/ssr-static.test.ts
npx tsc -p tests
```

静态专用测试覆盖公开字段白名单、XSS 转义、执行型/本地 URL 拒绝、基址与全部链接/锚点、私有文本泄露、分页和归档上限、报告修订不回填图，以及输出目录和符号链接保护。首次真实预览导出为 29 条公开资料、18 个主题、2 份报告；后续数量以本次清单与快照为准。

完整项目检查与浏览器审阅由主任务整合执行。静态导出成功本身不等于 GitHub 已推送、Pages 已部署或科学结论已经验证。
