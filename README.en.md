# AlgorithmHot · Research Radar

**Public site: [https://catl-21clab-sciagi.github.io/algorithmhot/](https://catl-21clab-sciagi.github.io/algorithmhot/)**

A Chinese research reading site covering **algorithms, AI4AI, AI for Science, and battery / new energy materials**. It collects paper announcements, journal metadata, research blogs and community recommendations; produces Chinese titles, summaries and reading notes; groups related reports; and compiles daily, weekly and monthly issues.

The focus is on method changes, applicable tasks, comparison conditions and evidence limitations. Summaries and results reported by authors are not independent reproductions.

[中文完整说明](README.md) · [Static reading mirror](https://catl-21clab-sciagi.github.io/algorithmhot/) · [Deployment](docs/deploy.md)

`main` contains source code. `gh-pages` contains a separately published static mirror. A clone does not include the existing article database, credentials or run records, and a source push does not refresh the mirror.

Screenshots were captured from the live public mirror on **2026-10-14 (Asia/Shanghai)**. Click an image to open its source page; see the [capture record](docs/screenshots/2026-10-14/manifest.json).

[![Selected research, grouped by date.](docs/screenshots/2026-10-14/home.png)](https://catl-21clab-sciagi.github.io/algorithmhot/)

*Selected research, grouped by date.*

## What is included

- **Sources:** three arXiv feed groups covering six categories; six journals through Crossref; Google DeepMind, Berkeley BAIR and Hugging Face Daily Papers.
- **Selection and reading:** prefiltering, two independent scores, Chinese summaries, reading recommendations, categories, topics, search, bookmarks and unread filtering.
- **Events and attention:** related reports grouped into events; a seven-day attention window with a 48-hour half-life and at least two independent participants. Attention is not scientific validation.
- **Reports:** rule-based daily selection; weekly and monthly compilations from daily issues, with model-written introductions.
- **Evidence notes and figures:** available paper identifiers, dates, source links, PDF links, license metadata and image provenance. Missing figures do not block publication.
- **Operations:** source health, model settings, request receipts, request-count limits and task records.
- **Read-only access:** RSS, public HTTP API, MCP and Agent Markdown on the full application, plus an optional GitHub Pages mirror.

Paper feeds are configured in [industry/research-feeds.json](industry/research-feeds.json), and blog/community sources in [industry/sources.json](industry/sources.json). The journals are Nature, Nature Energy, Nature Materials, Science, Angewandte Chemie International Edition and JACS. DOI patterns and, for some journals, keywords constrain collection before model selection.


[![AI for Science category.](docs/screenshots/2026-10-14/ai4s.png)](https://catl-21clab-sciagi.github.io/algorithmhot/c/ai4s/)

*AI for Science category.*


[![Paper detail with source notes, figure and reading recommendation.](docs/screenshots/2026-10-14/paper-detail.png)](https://catl-21clab-sciagi.github.io/algorithmhot/items/d0bjbamidu90d2u8fwfet74az/)

*Paper detail with source notes, figure and reading recommendation.*


[![Browse research topics, material types and institutions.](docs/screenshots/2026-10-14/topics.png)](https://catl-21clab-sciagi.github.io/algorithmhot/topics/)

*Browse research topics, material types and institutions.*

## Run with Docker Compose

You need Git, Node.js **24.11+** to generate configuration, and Docker with Compose. The containers use Node.js 24 and PostgreSQL 17.

```bash
git clone https://github.com/CATL-21CLab-SCIAGI/algorithmhot.git
cd algorithmhot
node scripts/init-env.ts
```

The initializer generates `.env`, random secrets and an administrator password. It refuses to overwrite an existing `.env`. Edit the file before starting; for an initial interface check, set:

```dotenv
COLLECT_ENABLED=false
MODEL_CALLS_ENABLED=false
PAGES_MIRROR_ENABLED=false
```

```bash
docker compose up -d --build
docker compose ps
```

Open [http://localhost:3000](http://localhost:3000). The admin area is `/admin`; use `ADMIN_PASSWORD` from your local `.env`. Compose migrates the database, seeds configured sources and starts the API, web server and worker. With collection and model calls disabled, a fresh database will not generate research content.

To collect and process material, configure your own `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` and request limits, enable `COLLECT_ENABLED` and `MODEL_CALLS_ENABLED`, then run `docker compose up -d` again. The worker will make external requests and incur charges from the configured providers.

[.env.example](.env.example) currently includes an AWS Bedrock endpoint and a model identifier as an example. Verify access and compatibility in your own environment. Match reasoning parameters, JSON mode and output limits to your provider. Git ignores `.env`, `.env.*` (except `.env.example`) and `.data/`; exclude any separately named credential files yourself and do not commit real secrets.

For native local processes, install dependencies with `npm ci`, build with `npm run build -w @aihot/web`, and configure a PostgreSQL connection in `.env`. The `local:up`, `local:status`, `local:daily` and `local:down` scripts manage the stack; see [the local operation guide](docs/local-daily.md). `local:up` and `local:daily` perform migrations, write state and start the worker; they are not read-only checks.

## Scheduling and limits

The resident worker uses pg-boss and PostgreSQL. It does not require a live Codex session. Reading a page does not call a model.

- **Dates:** arXiv announcements are assigned to 08:00 Beijing time on their announcement date as a site convention. Journal entries use Crossref `published-online` where available, otherwise discovery time. Other material uses available source timestamps; timeline placement is capped at discovery time.
- **Daily issues:** the exact window is `(previous day 08:00:00, issue day 08:00:00]`, Beijing time. Selection is rule-based and daily composition itself does not call a model. Current limits are 20 main entries, 20 short entries and 8 main entries per source.
- **Waiting:** before 12:00, a daily issue may wait for arXiv collection or material assessment. At 12:00 those holds are lifted; missing assessed material or task errors can still prevent publication.
- **Weekly/monthly:** scheduled from Monday 10:00 and the first day of each month at 10:30, Beijing time. Models write introductions, with a plain-text fallback on writing failure.
- **History:** scheduled runs fill missing issues without replacing published dailies. Explicit `reports:daily -- --replace YYYY-MM-DD` preserves the replaced issue as a revision.
- **Budgets:** `LLM_BUDGET_PER_MINUTE`, `_PER_HOUR` and `_PER_DAY` set rolling request-attempt limits for the default `llm` service, not monetary limits. `report_*` writing is exempt from the daily count limit but remains subject to minute/hour limits; any zero limit also stops it. Check the corresponding service budget when selecting a named model preset.

Times, report size and the attention window are in [site/site.ts](site/site.ts). Prompts, taxonomy and thresholds are under [industry/](industry/); model presets are in [site/models.ts](site/models.ts).


[![Daily issue dated 2026-10-13.](docs/screenshots/2026-10-14/daily.png)](https://catl-21clab-sciagi.github.io/algorithmhot/daily/)

*Daily issue dated 2026-10-13.*


[![Weekly issue for week 41 of 2026.](docs/screenshots/2026-10-14/weekly.png)](https://catl-21clab-sciagi.github.io/algorithmhot/weekly/)

*Weekly issue for week 41 of 2026.*

## Full application and mirror

The full application exposes `/agent`, `/feed.xml`, `/feed/daily.xml`, `/api/v1/agent`, `/llms.txt`, `/api/v1/items`, `/openapi-v1.json` and `/api/mcp`. MCP tools use the `algorithmhot` prefix.

The optional [Pages module](modules/pages-mirror/) is disabled by default. When enabled, its default schedule is minute 40 of each hour, with a 400-page limit. It strips scripts and publishes public reading pages and static category views. Search, bookmarks, tag/unread interactions, APIs and administration require the full application. The mirror is not a database backup; skipped pages and publication errors are recorded separately.


[![Agent integration instructions: MCP, RSS and REST API.](docs/screenshots/2026-10-14/agent.png)](https://catl-21clab-sciagi.github.io/algorithmhot/agent/)

*Agent integration instructions: MCP, RSS and REST API.*

The localhost address in this screenshot reflects the current site configuration. Use your deployed full application for API / MCP requests; GitHub Pages does not host these backend services.

## Development checks

```bash
npm ci
npm run typecheck
npm run test:standalone
npm run build -w @aihot/web
npx playwright install chromium webkit
node --test apps/web/tests/*.test.ts

# Replace the password; use a disposable test database and a role that can create databases.
DATABASE_URL='postgres://postgres:replace-with-test-password@127.0.0.1:5432/algorithmhot_test' npm test

# Against an already running site:
node scripts/smoke.ts --base http://localhost:3000
```

Test database names must end in `_test` or `_ci`. Backup tests also require PostgreSQL 17-compatible `pg_dump` and `pg_restore`. Web tests require the matching Playwright browsers. Model tests use local stubs.

## Boundaries

Source coverage is finite. Crossref currently queries the first configured ISSN per journal, with a result cap and no pagination. arXiv backfill depends on its recent `pastweek` listing; the `TO` argument of `research:backfill FROM TO` applies only to arXiv, while journal backfill queries from `FROM` with its own result cap. These are not exhaustive historical searches.

Many inputs contain only abstracts and metadata. Generated summaries are not full-paper reviews; selection accuracy still needs calibration on labeled examples. Figure retrieval filters license metadata and records provenance, but does not guarantee per-image rights verification or image availability. Missing content or a missing issue does not establish that no new research exists.

Implementation support for scheduling and deployment does not prove a live deployment is healthy. Check its actual task records, receipts and published output.

## Structure and documentation

The code is split into `apps/web`, `apps/api`, `apps/worker`, shared backend/contracts packages, `modules/research`, `modules/pages-mirror`, and the `industry` / `site` configuration workspaces.

See [the Chinese README](README.md) for the configuration map and operating commands, [deployment](docs/deploy.md), [architecture](docs/architecture.md), [selection and calibration](docs/selection.md), and [AlgorithmHot's rebuild notes](docs/algorithmhot.md).

## Upstream and license

AlgorithmHot is built on [KKKKhazix/AIHOT](https://github.com/KKKKhazix/AIHOT), with the current rebuild based on `652bd6b`. It retains the framework's collection, scoring, event grouping, publication layer and administration, and adds research-specific configuration and modules. Internal `@aihot/*` package names are retained.

Code is licensed under the [MIT License](LICENSE). Original copyright and third-party notices are in [NOTICE](NOTICE). Papers, images and publisher content remain subject to their own terms.
