// Public consensus method v15 (docs/leaderboard.md), exactly as the rules page states it.
// Everything here is part of the method: changing any constant changes reader-visible rankings
// and needs a new method version, published with the changed rules page.
import { ndtr } from "./ndtr.ts";
import { reversalCost, solveKemeny } from "./kemeny.ts";

export const METHOD_VERSION = "2026.09-public-consensus-v15";
export const SCORE_DEFINITION = "Cumulative Kemeny ordering support relative to fixed anchors; not capability distance or calibrated win probability";
export const DISPLAY_METHOD = "kemeny-order-support-1.0";

/** Evidence budgets: broad 30%, human preference 10%, specialised evaluations 60%. */
export const BUDGETS = [
  { key: "broad", name: "综合评测", weight: 0.3 },
  { key: "preference", name: "真人盲选", weight: 0.1 },
  { key: "coding", name: "编程与设计", weight: 0.12 },
  { key: "writing", name: "写作与表达", weight: 0.09 },
  { key: "reasoning", name: "数学与推理", weight: 0.12 },
  { key: "knowledge", name: "知识与事实", weight: 0.06 },
  { key: "vision", name: "视觉理解", weight: 0.06 },
  { key: "tools", name: "工具与办公", weight: 0.06 },
  { key: "multilingual", name: "中文与多语言", weight: 0.06 },
  { key: "professional", name: "行业专业任务", weight: 0.03 },
] as const;

/** Budgets that count as a "专项" for the overall eligibility rule. */
const SPECIALTY_EXCLUDED = new Set(["broad", "preference"]);

export interface ScoringSource {
  key: string;
  /** Scored metric; multi-metric sources name the one metric that votes. */
  unit: string;
  weight: number;
  family: string;
  operator: string;
  budget: string;
  category: string | null;
  /** False while a budgeted source awaits comparable evidence: it keeps its budget share but casts no votes. */
  scoring: boolean;
  /** Published bounds are ±intervalSd standard errors; null when a source has no error model. */
  intervalSd: number | null;
  direction: "HIGHER" | "LOWER";
}

export const SCORING_SOURCES: ScoringSource[] = [
  { key: "artificial-analysis", unit: "artificial-analysis:intelligence", weight: 0.3, family: "broad-composite", operator: "artificial-analysis", budget: "broad", category: null, scoring: true, intervalSd: null, direction: "HIGHER" },
  { key: "artificial-analysis-multilingual", unit: "artificial-analysis-multilingual", weight: 0.06, family: "multilingual", operator: "artificial-analysis", budget: "multilingual", category: null, scoring: false, intervalSd: null, direction: "HIGHER" },
  { key: "arena-text", unit: "arena-text", weight: 0.05, family: "arena-preference", operator: "arena", budget: "preference", category: null, scoring: true, intervalSd: 1.96, direction: "HIGHER" },
  { key: "arena-webdev", unit: "arena-webdev", weight: 0.024, family: "arena-preference", operator: "arena", budget: "coding", category: "aesthetics", scoring: true, intervalSd: 1.96, direction: "HIGHER" },
  { key: "mercor-apex-agents", unit: "mercor-apex-agents:loop-pass-1", weight: 0.04, family: "professional-work", operator: "mercor", budget: "tools", category: "professional", scoring: true, intervalSd: null, direction: "HIGHER" },
  { key: "vals-finance-agent", unit: "vals-finance-agent", weight: 0.03, family: "professional-work", operator: "vals-ai", budget: "professional", category: "professional", scoring: true, intervalSd: 1, direction: "HIGHER" },
  { key: "deepswe-v1-1", unit: "deepswe-v1-1", weight: 0.036, family: "software-engineering", operator: "datacurve", budget: "coding", category: "coding", scoring: true, intervalSd: 1.96, direction: "HIGHER" },
  { key: "taptap-maker", unit: "taptap-maker", weight: 0.036, family: "game-development", operator: "taptap-maker", budget: "coding", category: "coding", scoring: true, intervalSd: 1.96, direction: "HIGHER" },
  { key: "livebench-coding", unit: "livebench-coding", weight: 0.024, family: "rolling-objective", operator: "livebench", budget: "coding", category: "coding", scoring: true, intervalSd: null, direction: "HIGHER" },
  { key: "livebench-reasoning", unit: "livebench-reasoning", weight: 0.042, family: "rolling-objective", operator: "livebench", budget: "reasoning", category: "reasoning", scoring: true, intervalSd: null, direction: "HIGHER" },
  { key: "livebench-writing", unit: "livebench-writing", weight: 0.03, family: "rolling-objective", operator: "livebench", budget: "writing", category: null, scoring: true, intervalSd: null, direction: "HIGHER" },
  { key: "arena-creative-writing", unit: "arena-creative-writing", weight: 0.05, family: "arena-preference", operator: "arena", budget: "preference", category: "writing", scoring: true, intervalSd: 1.96, direction: "HIGHER" },
  { key: "arena-vision", unit: "arena-vision", weight: 0.06, family: "arena-preference", operator: "arena", budget: "vision", category: null, scoring: true, intervalSd: 1.96, direction: "HIGHER" },
  { key: "tau-banking", unit: "tau-banking", weight: 0.02, family: "customer-service-banking", operator: "sierra", budget: "tools", category: "professional", scoring: false, intervalSd: null, direction: "HIGHER" },
  { key: "epoch-simpleqa", unit: "epoch-simpleqa", weight: 0.04, family: "epoch-simpleqa", operator: "epoch-ai", budget: "knowledge", category: "knowledge", scoring: true, intervalSd: 1, direction: "HIGHER" },
  { key: "epoch-gpqa", unit: "epoch-gpqa", weight: 0.02, family: "epoch-gpqa", operator: "epoch-ai", budget: "knowledge", category: "knowledge", scoring: true, intervalSd: 1, direction: "HIGHER" },
  { key: "epoch-frontiermath", unit: "epoch-frontiermath", weight: 0.036, family: "research-mathematics", operator: "epoch-ai", budget: "reasoning", category: "reasoning", scoring: true, intervalSd: 1, direction: "HIGHER" },
  { key: "epoch-frontiermath-tier4", unit: "epoch-frontiermath-tier4", weight: 0.012, family: "research-mathematics", operator: "epoch-ai", budget: "reasoning", category: "reasoning", scoring: true, intervalSd: 1, direction: "HIGHER" },
  { key: "epoch-chess", unit: "epoch-chess", weight: 0.018, family: "novel-game-reasoning", operator: "epoch-ai", budget: "reasoning", category: "reasoning", scoring: true, intervalSd: 1, direction: "HIGHER" },
  { key: "epoch-mystery", unit: "epoch-mystery", weight: 0.012, family: "novel-game-reasoning", operator: "epoch-ai", budget: "reasoning", category: "reasoning", scoring: true, intervalSd: 1, direction: "HIGHER" },
  { key: "eq-creative", unit: "eq-creative", weight: 0.036, family: "judged-creative-writing", operator: "eq-bench", budget: "writing", category: "writing", scoring: true, intervalSd: null, direction: "HIGHER" },
  { key: "eq-longform", unit: "eq-longform", weight: 0.024, family: "judged-creative-writing", operator: "eq-bench", budget: "writing", category: "writing", scoring: true, intervalSd: null, direction: "HIGHER" },
];

/** Fixed reference models for the index scale; they never decide who ranks where. */
export const ANCHORS = [
  "claude-fable-5", "gpt-5-6-sol", "kimi-k-3", "qwen-3-8-max", "gpt-5-4", "claude-opus-4-8", "claude-sonnet-5", "grok-4-5", "gemini-3-5-flash",
  "glm-5-2", "claude-sonnet-4-6", "qwen-3-7-max", "kimi-k-2-6", "deepseek-v-4-pro", "qwen-3-6-plus", "minimax-m-3", "gpt-5-4-mini", "grok-4-3",
];

export const BOARD_KEYS = ["overall", "coding", "aesthetics", "reasoning", "knowledge", "writing", "professional"] as const;
export type BoardKey = (typeof BOARD_KEYS)[number];

export interface Policy {
  sources: number;
  families: number;
  operators: number;
  categories: number;
  directAnchors: number;
}

export const OVERALL_POLICY: Policy = { sources: 3, families: 3, operators: 3, categories: 3, directAnchors: 2 };

/** Category boards ask for two sources from two operators when the category has them. */
export function categoryPolicy(units: number, operators: number): Policy {
  return { sources: Math.min(2, units), families: 1, operators: Math.min(2, operators), categories: 0, directAnchors: 1 };
}

/** Models released more than this long before the run are not ranked (unknown dates stay). */
export const RELEASE_WINDOW_MONTHS = 18;

/** Categories need at least this many models to publish, besides the source rule. */
export const CATEGORY_MIN_MODELS = 5;

export interface SignalRow {
  score: number;
  modelSlug: string;
  lowerBound: number | null;
  upperBound: number | null;
  configuration: string;
}

export interface RegistryEntry {
  family: string;
  weight: number;
  operator: string;
  protocol: string;
  direction: "HIGHER" | "LOWER";
  interval_sd: number | null;
}

export interface BoardInput {
  board: string;
  names: Record<string, string>;
  models: string[];
  policy: Policy;
  anchors: string[];
  signals: Array<{ key: string; rows: SignalRow[] }>;
  registry: Record<string, RegistryEntry>;
  qualificationScenarios: Record<string, { units: string[]; models: string[] }>;
}

export interface Stability {
  from: number;
  to: number;
  fixedFrom: number;
  fixedTo: number;
  scenarios: number;
  sensitive: boolean;
  incomplete: number;
  ordinalRank: number;
  unavailable: number;
}

export interface BoardEntry {
  name: string;
  rank: number;
  slug: string;
  score: number;
  coverage: number;
  stability: Stability;
  source_count: number;
  operator_count: number;
}

export interface BoardOutput {
  board: string;
  solver: { optimal: boolean; lower_bound: number; absolute_gap: number; reversal_cost: number };
  display: { gaps: Array<{ gap: number; lower: string; higher: string }>; method: string; max_optimization_gap: number };
  entries: BoardEntry[];
  comparisons: Record<string, Array<{ net: number; slug: string; shared: number; directCount: number }>>;
  model_count: number;
  source_count: number;
  active_budget: number;
  score_definition: string;
  connected_components: number;
  publishable_connectivity: boolean;
  observed_weighted_agreement: number;
}

interface NetMatrix {
  models: string[];
  index: Map<string, number>;
  M: Float64Array[];
  W: Float64Array[];
  shared: Int32Array[];
}

/** Soft comparison: both sides with published errors use 2Φ(Δ/SE) − 1 (zero covariance), else the sign. */
function pairSupport(a: SignalRow, b: SignalRow, reg: RegistryEntry, ordinal: boolean): number {
  let diff = a.score - b.score;
  if (reg.direction === "LOWER") diff = -diff;
  const soft = !ordinal && reg.interval_sd != null && a.lowerBound != null && a.upperBound != null && b.lowerBound != null && b.upperBound != null;
  if (!soft) return Math.sign(diff);
  const sa = (a.upperBound! - a.lowerBound!) / (2 * reg.interval_sd!);
  const sb = (b.upperBound! - b.lowerBound!) / (2 * reg.interval_sd!);
  const se = Math.sqrt(sa * sa + sb * sb);
  return se > 0 ? 2 * ndtr(diff / se) - 1 : Math.sign(diff);
}

export function netMatrix(input: Pick<BoardInput, "models" | "signals" | "registry">, opts: { weightScale?: Record<string, number>; ordinal?: boolean; units?: string[] } = {}): NetMatrix {
  const models = input.models;
  const index = new Map(models.map((m, i) => [m, i]));
  const n = models.length;
  const M = Array.from({ length: n }, () => new Float64Array(n));
  const W = Array.from({ length: n }, () => new Float64Array(n));
  const shared = Array.from({ length: n }, () => new Int32Array(n));
  for (const sig of input.signals) {
    if (opts.units && !opts.units.includes(sig.key)) continue;
    const reg = input.registry[sig.key];
    if (!reg) continue;
    const w = reg.weight * (opts.weightScale?.[sig.key] ?? 1);
    if (!w) continue;
    const rows = sig.rows.filter((r) => index.has(r.modelSlug));
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i]!;
        const b = rows[j]!;
        const p = w * pairSupport(a, b, reg, !!opts.ordinal);
        const ia = index.get(a.modelSlug)!;
        const ib = index.get(b.modelSlug)!;
        M[ia]![ib]! += p;
        M[ib]![ia]! -= p;
        W[ia]![ib]! += w;
        W[ib]![ia]! += w;
        shared[ia]![ib]! += 1;
        shared[ib]![ia]! += 1;
      }
    }
  }
  return { models, index, M, W, shared };
}

function subInput(input: BoardInput, models: string[]) {
  return { models: [...models].sort(), signals: input.signals, registry: input.registry };
}

/** Rank each model in one scenario; exact ties prefer the published base order. */
async function scenarioRanks(input: BoardInput, models: string[], baseRank: Map<string, number>, opts: { units?: string[]; weightScale?: Record<string, number>; ordinal?: boolean }) {
  const net = netMatrix(subInput(input, models), opts);
  const prefer = [...net.models.keys()].sort((a, b) => (baseRank.get(net.models[a]!) ?? 1e9) - (baseRank.get(net.models[b]!) ?? 1e9) || a - b);
  const r = await solveKemeny(net.M, { prefer });
  return { ranks: new Map(r.order.map((i, p) => [net.models[i]!, p + 1])), optimal: r.optimal };
}

function components(W: Float64Array[]): number {
  const n = W.length;
  const seen = new Uint8Array(n);
  let count = 0;
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    count++;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const v = stack.pop()!;
      for (let u = 0; u < n; u++) if (!seen[u] && W[v]![u]! > 0) { seen[u] = 1; stack.push(u); }
    }
  }
  return count;
}

const logistic = (x: number) => 1 / (1 + Math.exp(-x));

export async function computeBoard(input: BoardInput): Promise<BoardOutput> {
  const net = netMatrix(input);
  const { models, M, W, shared } = net;
  const n = models.length;
  // Base order; exact ties fall back to the fixed model ID (slug) order.
  const base = await solveKemeny(M, { prefer: [...models.keys()] });
  const order = base.order;
  let maxOptimizationGap = Math.max(0, base.cost - base.lowerBound);

  // Display gaps: the least extra reversed support needed to swap each adjacent pair.
  const gaps: BoardOutput["display"]["gaps"] = [];
  for (let p = 0; p + 1 < order.length; p++) {
    const hi = order[p]!;
    const lo = order[p + 1]!;
    const r = await solveKemeny(M, { force: [[lo, hi]] });
    maxOptimizationGap = Math.max(maxOptimizationGap, Math.max(0, r.cost - r.lowerBound));
    gaps.push({ gap: Math.max(0, r.cost - base.cost), lower: models[lo]!, higher: models[hi]! });
  }

  // Index: cumulative support from the bottom, averaged logistic against the anchors on this board.
  const v = new Array<number>(n).fill(0);
  for (let i = n - 2; i >= 0; i--) v[i] = v[i + 1]! + gaps[i]!.gap;
  const anchorValues = input.anchors.map((a) => order.findIndex((m) => models[m] === a)).filter((p) => p >= 0).map((p) => v[p]!);
  const indexOf = (p: number) => (anchorValues.length ? (100 * anchorValues.reduce((s, a) => s + logistic(v[p]! - a), 0)) / anchorValues.length : 50);

  const baseRank = new Map(order.map((m, p) => [models[m]!, p + 1]));
  const allUnits = input.signals.map((s) => s.key);
  const remaining = (key: string) => {
    const [kind, ...rest] = key.split(":");
    const name = rest.join(":");
    return allUnits.filter((u) => (kind === "operator" ? input.registry[u]?.operator !== name : u !== name));
  };

  // Stability: drop each operator or unit (re-checking eligibility, and again with the candidates fixed),
  // move each unit weight ±20%, and switch every comparison to ordinal.
  const scenarios: Array<{ requal: Map<string, number>; fixed: Map<string, number>; ok: boolean }> = [];
  let ordinalRanks = new Map<string, number>();
  for (const [key, q] of Object.entries(input.qualificationScenarios)) {
    const requal = q.models.length ? await scenarioRanks(input, q.models, baseRank, { units: q.units }) : { ranks: new Map(), optimal: true };
    const fixed = await scenarioRanks(input, input.models, baseRank, { units: remaining(key) });
    scenarios.push({ requal: requal.ranks, fixed: fixed.ranks, ok: requal.optimal && fixed.optimal });
  }
  for (const unit of allUnits) {
    for (const factor of [0.8, 1.2]) {
      const r = await scenarioRanks(input, input.models, baseRank, { weightScale: { [unit]: factor } });
      scenarios.push({ requal: r.ranks, fixed: r.ranks, ok: r.optimal });
    }
  }
  {
    const r = await scenarioRanks(input, input.models, baseRank, { ordinal: true });
    ordinalRanks = r.ranks;
    scenarios.push({ requal: r.ranks, fixed: r.ranks, ok: r.optimal });
  }

  const unitsOf = (slug: string) => input.signals.filter((s) => input.registry[s.key]?.weight && s.rows.some((r) => r.modelSlug === slug)).map((s) => s.key);
  const top = order.slice(0, 30);
  const entries: BoardEntry[] = order.map((m, p) => {
    const slug = models[m]!;
    const rank = p + 1;
    let from = rank, to = rank, fixedFrom = rank, fixedTo = rank, unavailable = 0, incomplete = 0;
    for (const s of scenarios) {
      if (!s.ok) incomplete++;
      const r = s.requal.get(slug);
      if (r === undefined) unavailable++;
      else { from = Math.min(from, r); to = Math.max(to, r); }
      const f = s.fixed.get(slug);
      if (f !== undefined) { fixedFrom = Math.min(fixedFrom, f); fixedTo = Math.max(fixedTo, f); }
    }
    const units = unitsOf(slug);
    const coverage = units.reduce((s, u) => s + input.registry[u]!.weight, 0);
    return {
      name: input.names[slug] ?? slug,
      rank,
      slug,
      score: Math.round(indexOf(p) * 10) / 10,
      coverage: Math.round(coverage * 1e9) / 1e9,
      stability: {
        from,
        to,
        fixedFrom,
        fixedTo,
        scenarios: scenarios.length,
        sensitive: to - from >= 3 || fixedTo - fixedFrom >= 3 || unavailable > 0 || incomplete > 0,
        incomplete,
        ordinalRank: ordinalRanks.get(slug) ?? rank,
        unavailable,
      },
      source_count: units.length,
      operator_count: new Set(units.map((u) => input.registry[u]!.operator)).size,
    };
  });

  const comparisons: BoardOutput["comparisons"] = {};
  for (const m of order) {
    comparisons[models[m]!] = top.filter((t) => t !== m).map((t) => ({ net: M[m]![t]!, slug: models[t]!, shared: W[m]![t]!, directCount: shared[m]![t]! }));
  }

  // Weighted agreement between the published order and every single-source comparison.
  let agree = 0;
  let total = 0;
  for (const sig of input.signals) {
    const reg = input.registry[sig.key];
    if (!reg?.weight) continue;
    const rows = sig.rows.filter((r) => baseRank.has(r.modelSlug));
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const p = pairSupport(rows[i]!, rows[j]!, reg, false);
        const s = baseRank.get(rows[i]!.modelSlug)! < baseRank.get(rows[j]!.modelSlug)! ? 1 : -1;
        agree += (reg.weight * (1 + p * s)) / 2;
        total += reg.weight;
      }
    }
  }

  const activeUnits = Object.entries(input.registry).filter(([u, r]) => r.weight > 0 && allUnits.includes(u));
  const componentCount = components(W);
  return {
    board: input.board,
    solver: { optimal: base.optimal, lower_bound: base.lowerBound, absolute_gap: Math.max(0, base.cost - base.lowerBound), reversal_cost: reversalCost(M, order) },
    display: { gaps, method: DISPLAY_METHOD, max_optimization_gap: maxOptimizationGap },
    entries,
    comparisons,
    model_count: n,
    source_count: activeUnits.length,
    active_budget: activeUnits.reduce((s, [, r]) => s + r.weight, 0),
    score_definition: SCORE_DEFINITION,
    connected_components: componentCount,
    publishable_connectivity: componentCount === 1,
    observed_weighted_agreement: total ? agree / total : 1,
  };
}
