import { writeFile, mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { beijingDate } from "@aihot/contracts/time";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { collectResearchRun, createResearchRun } from "@aihot/backend/research/collect";
import { prepareRefreshRun } from "@aihot/backend/research/refresh";
import { freezeAdmissions, researchProcessingQueue, researchRunMetrics } from "@aihot/backend/research/admission";
import { processArticle } from "@aihot/backend/jobs/content";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { publishArticle } from "@aihot/backend/publication/publish";
import { ensureModelRun, getModelRun } from "@aihot/backend/providers/model-runs";
import { BudgetExceededError } from "@aihot/backend/providers/receipts";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { composePilot } from "@aihot/backend/reports/compose";
import { generateResearchBrief } from "@aihot/backend/research/brief";
import { generateResearchRoadmap } from "@aihot/backend/research/roadmap";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { assertResearchRequestsIdle, heldRequestMessage, processIsolatedResearchArticles, runIsolatedArticleStep } from "@aihot/backend/research/request-isolation";

const id = process.argv[2];
const action = process.argv[3] ?? "status";
if (!id || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("stable research run ID required");
if (!['collect','process','roadmaps','roadmaps-retry-failed','report','revise','status','all','refresh'].includes(action)) throw new Error("invalid run action");
const refreshing = action === "refresh";
const refreshId = /^refresh-\d{4}-\d{2}-\d{2}-\d{2}(?:-r1)?$/.test(id);
const sharedBudget = process.env.RESEARCH_MODEL_RUN_ID?.trim();
if (sharedBudget && (sharedBudget !== `daily-${beijingDate(new Date())}` || refreshId || /^daily-/.test(id))) {
  throw new Error("Historical work may only share today's daily model allowance; daily and refresh budgets cannot be overridden");
}
let budgetId = refreshId ? `daily-${id.slice(8,18)}` : id;
process.env.MODEL_RUN_ID = budgetId;
process.env.RESEARCH_RUN_ID = id;
process.env.RESEARCH_ADMISSION_ENABLED = "true";
process.env.RESEARCH_REQUEST_ISOLATION = "true";
async function hasArticleBudget() {
  const b = await getModelRun(budgetId);
  const ceiling = process.env.MODEL_RUN_CALL_CEILING ? Number(process.env.MODEL_RUN_CALL_CEILING) : Infinity;
  return Boolean(b && b.remaining > b.reportReserve && b.callsUsed < ceiling);
}
async function illustrate() {
  // The same deterministic order as the edition: one focus paper per nonempty category.
  const rows = await sql<{ id: string; category: string }[]>`
    SELECT p.article_id AS id,p.category FROM publications p
    JOIN research_members m ON m.article_id=p.article_id JOIN research_runs r ON r.id=m.run_id
    WHERE m.run_id=${id} AND m.admitted AND p.eligible AND p.selected
      AND p.visibility='public' AND p.visible_after<=now() AND p.research_brief IS NOT NULL
      AND (r.kind='pilot' OR NOT p.backfill)
    ORDER BY p.score DESC,p.published_at DESC,p.article_id`;
  const dir = path.join(config.dataDir, "research", id);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "roadmaps.json");
  type Entry = { articleId: string; state: string; receiptId?: number | null; error?: string };
  let journal: { runId: string; selected: string[]; results: Entry[] };
  try { journal = JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    journal = { runId: id, selected: CATEGORIES.flatMap(c => rows.find(r => r.category === c.key)?.id ?? []), results: [] };
  }
  if (journal.runId !== id || journal.selected.length > 3) throw new Error("Invalid roadmap checkpoint");
  // Keep the legacy action as a safe alias: failed/UNKNOWN checkpoints are never cleared.
  async function save() {
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(journal, null, 2), { mode: 0o600 });
    await rename(temp, file);
  }
  await save();
  for (const articleId of journal.selected) {
    // A submitted checkpoint without completion is uncertain, never an automatic fresh attempt.
    if (journal.results.some(r => r.articleId === articleId)) continue;
    if (!(await hasArticleBudget())) break;
    const entry: Entry = { articleId, state: "submitted" };
    journal.results.push(entry); await save();
    try {
      const result = await runIsolatedArticleStep(id, articleId, () => generateResearchRoadmap(articleId, { holdFailed: true }));
      if (result.state === "held") {
        entry.state = `held-${result.hold.status}`; entry.receiptId = result.hold.receiptId;
        entry.error = heldRequestMessage(result.hold);
      } else { entry.state = result.value.state; entry.receiptId = result.value.receiptId; }
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        entry.state = "budget-deferred"; entry.error = String(error).slice(0, 1200);
        await save(); break;
      }
      entry.state = "stopped"; entry.error = String(error).slice(0, 1200);
      await save(); throw error;
    }
    await save(); console.log(JSON.stringify({ roadmap: entry }));
  }
}
try {
  if (action === "status") {
    const [run] = await sql`SELECT * FROM research_runs WHERE id = ${id}`;
    if (!run) throw new Error(`Research run ${id} does not exist`);
    budgetId = run.model_budget_id ?? budgetId;
    console.log(JSON.stringify({ run, ...await researchRunMetrics(id), budget: await getModelRun(budgetId) }));
  } else {
  const admissionPolicy = process.env.RESEARCH_ADMISSION_POLICY;
  if (admissionPolicy && !["legacy-capped", "all-in-window"].includes(admissionPolicy)) throw new Error("Invalid RESEARCH_ADMISSION_POLICY");
  const options = admissionPolicy === "all-in-window" ? { admissionPolicy: "all-in-window" as const,
    modelCallCeiling: Number(process.env.RESEARCH_MODEL_CALL_CEILING), ...(sharedBudget ? { modelBudgetId: sharedBudget } : {}) } : {};
  if (refreshing && admissionPolicy !== "all-in-window" && !(await sql`SELECT id FROM research_runs WHERE id=${id}`).length) {
    throw new Error("Legacy three-hour refreshes may only resume an existing run; create a 09:00, 15:00 or 21:00 review instead");
  }
  const start = process.env.RESEARCH_WINDOW_START, end = process.env.RESEARCH_WINDOW_END;
  if ((start || end) && (!start || !end || !sharedBudget)) throw new Error("Explicit historical windows require both boundaries and today's shared model budget");
  const explicitWindow = start && end ? { start: new Date(start), end: new Date(end) } : undefined;
  const run = refreshing ? await prepareRefreshRun(id, new Date(process.env.RESEARCH_REFRESH_END ?? ""), options)
    : await createResearchRun(id, process.env.RESEARCH_RUN_KIND === "daily" ? "daily" : "pilot", new Date(), explicitWindow, options);
  if (sharedBudget && !run.model_budget_id) throw new Error("An existing research run cannot acquire a different model budget");
  if (run.kind === "pilot" && run.model_budget_id && ["report", "revise", "all", "refresh"].includes(action)) {
    throw new Error("Shared historical runs only collect/process materials; compose the requested weekly or monthly edition separately");
  }
  budgetId = run.model_budget_id ?? budgetId;
  process.env.MODEL_RUN_ID = budgetId;
  if (run.model_call_ceiling !== null) process.env.MODEL_RUN_CALL_CEILING = String(run.model_call_ceiling);
  else delete process.env.MODEL_RUN_CALL_CEILING;
  await assertResearchRequestsIdle();
  await ensureModelRun({ id: budgetId, maxCalls: 600, reportReserve: 20 });
  if (action === "collect" || action === "all" || refreshing) await collectResearchRun(id);
  if (action === "process" || action === "all" || refreshing) {
    await freezeAdmissions(id);
    const rows = await researchProcessingQueue(id);
    try {
      await processIsolatedResearchArticles(id, rows, {
        process: processArticle, extract: articleId => extractArticleBody(articleId, false), brief: generateResearchBrief,
        hasBudget: hasArticleBudget, observed: (articleId, stage, result) => console.log(JSON.stringify({ article: articleId, stage, result })),
      });
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      // Reservations fail before an attempt exists. Keep the unfinished member pending so the
      // next scheduled review can reuse completed stages and continue within the same day budget.
      console.log(JSON.stringify({ processing: "budget-deferred", budgetId, error: String(error) }));
    }
    // Incorporate all HF metadata independent of arrival order; this makes no model call.
    for (const row of rows) await publishArticle(row.article_id);
  }
  await assertResearchRequestsIdle();
  if (["roadmaps","roadmaps-retry-failed"].includes(action) || ["all","refresh"].includes(action) && run.admission_policy !== "all-in-window") await illustrate();
  await assertResearchRequestsIdle();
  // A changed edition never turns an earlier failed/UNKNOWN report subject into a new model request.
  if (["report","revise","all","refresh"].includes(action)) console.log(JSON.stringify({ report: await composePilot(id, action === "revise" || refreshing,
    { ruleOnly: true, illustrated: run.admission_policy === "all-in-window" }) }));
  const receipt = { run: (await sql`SELECT * FROM research_runs WHERE id = ${id}`)[0], ...await researchRunMetrics(id), budget: await getModelRun(budgetId) };
  const dir = path.join(config.dataDir, "research", id); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  const members = await sql`SELECT m.*,a.title,a.url,a.published_at,a.backfill,a.backfill_reason,a.research FROM research_members m JOIN articles a ON a.id = m.article_id WHERE m.run_id = ${id} ORDER BY m.admission_rank NULLS LAST,a.id`;
  await writeFile(path.join(dir, "members.json"), JSON.stringify(members, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(receipt));
  }
} finally { await stopBoss(); await closeDb(); }
