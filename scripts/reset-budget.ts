// Explicit one-time allowance reset. Existing attempts, costs and unknown outcomes are retained.
// Use the same operation id when recovering an interrupted command; it cannot grant allowance twice.
// node --env-file=.env scripts/reset-budget.ts llm <operation-id> <reason>
import { closeDb } from "@aihot/backend/db";
import { getBudgetStatus, resetBudgetUsage } from "@aihot/backend/providers/budgets";

const [service, operationId, reason, ...extra] = process.argv.slice(2);
if (!service || !operationId || !reason || extra.length) {
  console.error("usage: node --env-file=.env scripts/reset-budget.ts <service> <operation-id> <reason>");
  process.exit(2);
}
try {
  const result = await resetBudgetUsage(service, { operationId, reason }, "operator:reset-budget");
  console.log(JSON.stringify({ service, ...result, budget: await getBudgetStatus(service) }, null, 2));
} finally {
  await closeDb();
}
