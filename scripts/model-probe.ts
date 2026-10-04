// One real, receipt-backed prefilter using a saved public source item; counted in the same run.
import { z } from "zod";
import { sql, closeDb } from "@aihot/backend/db";
import { chatJson } from "@aihot/backend/providers/llm";
import { completeReceipt } from "@aihot/backend/providers/receipts";
import { getModelRun } from "@aihot/backend/providers/model-runs";
import { PREFILTER_SYSTEM } from "@aihot/backend/editorial/writing";
import { PROMPT_VERSIONS } from "@aihot/backend/editorial/analyze";
try {
  const [a] = await sql`SELECT a.id,a.title,a.body_text FROM research_members m JOIN articles a ON a.id=m.article_id
    WHERE m.run_id=${process.env.MODEL_RUN_ID!} AND m.in_window AND NOT m.signal_only ORDER BY a.published_at DESC,a.id LIMIT 1 OFFSET ${Number(process.env.PROBE_ITEM_OFFSET ?? 0)}`;
  if (!a) throw new Error("Collect a source item first");
  const r = await chatJson({model:"default",purpose:"probe_prefilter",subject:`probe:${a.id}`,promptVersion:PROMPT_VERSIONS.prefilter,
    system:PREFILTER_SYSTEM,user:JSON.stringify({title:a.title,abstract:a.body_text}),
    schema:z.object({label:z.enum(["PASS","BLOCK","UNKNOWN"]),reason:z.string()}),maxTokens:512});
  await completeReceipt(sql,r.receiptId);
  console.log(JSON.stringify({receiptId:r.receiptId,reused:r.reused,data:r.data,usage:r.usage,budget:await getModelRun(process.env.MODEL_RUN_ID!)}));
} finally {await closeDb();}
