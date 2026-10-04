# 科研资料与试刊接口

所有出口从 `publication/` 读取已保存的数据；读网页、RSS、公开 API 和 MCP 均不调用模型。首版的算法、AI4AI、AI4S 分类分别使用 `algorithm`、`ai4ai`、`ai4s`。

## 研究元数据

站点资料详情、列表、公开 v1 条目、精选同步和报告引用可携带 `research`；旧资料为 `null`，最简同步字段继续省略该扩展。元数据包括：

- `canonicalKey`、`arxivId`、当前 `arxivVersion` 与已观测的 `arxivVersions`；abs、pdf、带版本号的同一 arXiv 论文共用论文身份。
- `originalPublishedAt`、`revisedAt`、`communitySelectedAt`、`observedAt`；不能确认的日期为 `null`，arXiv RSS 公告时间不被当成原始投稿日期。
- `evidenceBasis`：`abstract`、`fulltext`、`source_summary` 或 `unknown`。
- `links`：论文、项目、代码、权重链接，以及每条链接的 `sourceUrl`。链接存在不代表已经复现。
- `signalOnly`：HF 热度资料为独立信号，使用 `hf:<论文ID>` 身份，按 `canonicalKey` 关联论文；不会占用论文正文身份或进入精选。

摘要 RSS 在 description 中展示证据依据、四类日期与已知链接。研究资料缺少来源发表时间时省略 RSS pubDate，不把本站观测时间伪装成发表时间。

## 独立试刊

| 用途 | 路径 |
|---|---|
| 试刊索引 | `GET /api/v1/pilots?limit=30` |
| 最新试刊 | `GET /api/v1/pilots/latest` |
| 指定试刊 | `GET /api/v1/pilots/{key}` |
| 站点试刊详情 | `GET /api/site/reports/pilot/{key}` |
| 站点试刊最新一期 | `GET /api/site/reports/pilot/latest` |

`key` 使用索引返回的北京时间出刊日期 `YYYY-MM-DD`。试刊响应带 `kind: "pilot"`、`key`、`windowStart`、`windowEnd`、栏目与来源引用，`run` 保存批次 ID、状态、处理数量和缺口。正常日报继续使用 `/api/v1/dailies` 与 `date` 字段，同一天可以分别存在试刊与日报。空条目与来源或处理失败须结合 `run` 解读。

请求支持 ETag 和 HTTP 缓存；不存在的刊物返回 404，无效日期或未知查询参数返回 400。完整 schema 见 `/openapi-v1.json`。

## MCP

MCP 地址为 `/api/mcp`，提供六个匿名只读工具。`algorithmhot_get_latest` 和 `algorithmhot_search` 的结构化条目含同一份 `research`。新增 `algorithmhot_get_pilot` 的参数为可选 `key`：省略时读最新试刊；返回与 `/api/v1/pilots/{key}` 相同的结构化资料，以及保留窗口、范围和缺口的中文说明。`algorithmhot_get_daily` 继续只读取正式日报。

调用示例：

```json
{"name":"algorithmhot_get_pilot","arguments":{}}
```

测试使用本地数据和 HTTP stub；不会访问外部模型。研究解析测试为 `tests/research-metadata.test.ts`，数据库与公开出口测试为 `tests/research-storage.test.ts`、`tests/research-pilot-api.test.ts`，后两者必须运行在名称以 `_test` 或 `_ci` 结尾的隔离数据库。
