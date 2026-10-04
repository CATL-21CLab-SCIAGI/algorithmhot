import { writeFile, mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { collectResearchRun, createResearchRun } from "@aihot/backend/research/collect";
import { freezeAdmissions, researchRunMetrics } from "@aihot/backend/research/admission";
import { processArticle } from "@aihot/backend/jobs/content";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { publishArticle } from "@aihot/backend/publication/publish";
import { ensureModelRun, getModelRun } from "@aihot/backend/providers/model-runs";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { composePilot } from "@aihot/backend/reports/compose";
import { generateResearchBrief } from "@aihot/backend/research/brief";
import { generateResearchRoadmap } from "@aihot/backend/research/roadmap";
import { CATEGORIES } from "@aihot/industry/taxonomy";

const id = process.argv[2];
const action = process.argv[3] ?? "status";
if (!id || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("stable research run ID required");
if (!['collect','process','roadmaps','roadmaps-retry-failed','report','revise','status','all'].includes(action)) throw new Error("invalid run action");
process.env.MODEL_RUN_ID = id;
process.env.RESEARCH_ADMISSION_ENABLED = "true";
async function enrich(articleId: string) {
  const b = await getModelRun(id);
  if (b!.remaining <= b!.reportReserve) return false;
  try {
    const result = await generateResearchBrief(articleId);
    await sql`UPDATE research_members SET error=NULL WHERE run_id=${id} AND article_id=${articleId}`;
    console.log(JSON.stringify({ article: articleId, brief: result.state, budget: await getModelRun(id) }));
    return true;
  } catch (error) {
    const message=String(error).slice(0,1200);
    await sql`UPDATE research_members SET error=${`brief: ${message}`} WHERE run_id=${id} AND article_id=${articleId}`;
    console.log(JSON.stringify({article:articleId,brief:'failed-or-unknown',error:message}));
    return !/auth|login|quota|rate limit|usage limit|budget/i.test(message);
  }
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
  if (action === "roadmaps-retry-failed") {
    // Explicit operator recovery after a format fix, only terminal unusable-output receipts.
    // Submitted/UNKNOWN calls can never be unlocked through this path.
    const retry: string[] = [];
    for (const entry of journal.results.filter(r => r.state === "failed-or-unknown")) {
      const [receipt] = await sql<{ status: string; error: string }[]>`
        SELECT status,error FROM receipts WHERE purpose='research_roadmap' AND subject LIKE ${`article:${entry.articleId}@%`}
        ORDER BY id DESC LIMIT 1`;
      if (receipt?.status === "failed" && receipt.error?.startsWith("unusable output:")) retry.push(entry.articleId);
    }
    if (retry.length) {
      await writeFile(path.join(dir, `roadmaps-before-recovery-${Date.now()}.json`), JSON.stringify(journal, null, 2), { mode: 0o600 });
      journal.results = journal.results.filter(r => !retry.includes(r.articleId));
    }
  }
  async function save() {
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(journal, null, 2), { mode: 0o600 });
    await rename(temp, file);
  }
  await save();
  for (const articleId of journal.selected) {
    // A submitted checkpoint without completion is uncertain, never an automatic fresh attempt.
    if (journal.results.some(r => r.articleId === articleId)) continue;
    const budget = await getModelRun(id);
    if (!budget || budget.remaining <= budget.reportReserve) break;
    const entry: Entry = { articleId, state: "submitted" };
    journal.results.push(entry); await save();
    try {
      const result = await generateResearchRoadmap(articleId);
      entry.state = result.state; entry.receiptId = result.receiptId;
    } catch (error) {
      entry.state = "failed-or-unknown";
      entry.error = String(error).slice(0, 1200);
    }
    await save(); console.log(JSON.stringify({ roadmap: entry }));
    if (/auth|login|quota|rate limit|usage limit|budget/i.test(entry.error ?? "")) break;
  }
}
try {
  if (action === "status") {
    const [run] = await sql`SELECT * FROM research_runs WHERE id = ${id}`;
    if (!run) throw new Error(`Research run ${id} does not exist`);
    console.log(JSON.stringify({ run, ...await researchRunMetrics(id), budget: await getModelRun(id) }));
  } else {
  await createResearchRun(id, process.env.RESEARCH_RUN_KIND === "daily" ? "daily" : "pilot");
  await ensureModelRun({ id, maxCalls: 600, reportReserve: 20 });
  if (action === "collect" || action === "all") await collectResearchRun(id);
  if (action === "process" || action === "all") {
    await freezeAdmissions(id);
    const rows = await sql<{ article_id: string; state: string }[]>`SELECT article_id,state FROM research_members WHERE run_id = ${id} AND admitted ORDER BY admission_rank`;
    for (const row of rows) {
      if (["pass","block","unknown","unknown-receipt"].includes(row.state)) {
        if (row.state === "pass" && !(await enrich(row.article_id))) break;
        continue;
      }
      const budget = await getModelRun(id);
      if (budget!.remaining <= budget!.reportReserve) break;
      try {
        let result = await processArticle(row.article_id);
        if (result.state === "fetching-body") {
          await extractArticleBody(row.article_id, false);
          result = await processArticle(row.article_id);
        }
        await sql`UPDATE research_members SET state = ${result.state}, error = NULL, updated_at = now() WHERE run_id = ${id} AND article_id = ${row.article_id}`;
        console.log(JSON.stringify({ article: row.article_id, state: result.state, budget: await getModelRun(id) }));
        if (result.state === "pass" && !(await enrich(row.article_id))) break;
      } catch (error) {
        const message = String(error).slice(0, 1200);
        const unknown = /unknown outcome|outcome unknown|timed out|timeout/i.test(message);
        await sql`UPDATE research_members SET state = ${unknown ? "unknown-receipt" : "failed"}, error = ${message}, updated_at = now() WHERE run_id = ${id} AND article_id = ${row.article_id}`;
        console.log(JSON.stringify({ article: row.article_id, state: unknown ? "unknown-receipt" : "failed", error: message }));
        if (/auth|login|quota|rate limit|usage limit|budget/i.test(message)) break;
      }
    }
    // Incorporate all HF metadata independent of arrival order; this makes no model call.
    for (const row of rows) await publishArticle(row.article_id);
  }
  if (["roadmaps","roadmaps-retry-failed","all"].includes(action)) await illustrate();
  if (["report","revise","all"].includes(action)) console.log(JSON.stringify({ report: await composePilot(id, action === "revise") }));
  const receipt = { run: (await sql`SELECT * FROM research_runs WHERE id = ${id}`)[0], ...await researchRunMetrics(id), budget: await getModelRun(id) };
  const dir = path.join(config.dataDir, "research", id); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  const members = await sql`SELECT m.*,a.title,a.url,a.published_at,a.backfill,a.backfill_reason,a.research FROM research_members m JOIN articles a ON a.id = m.article_id WHERE m.run_id = ${id} ORDER BY m.admission_rank NULLS LAST,a.id`;
  await writeFile(path.join(dir, "members.json"), JSON.stringify(members, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(receipt));
  }
} finally { await stopBoss(); await closeDb(); }
