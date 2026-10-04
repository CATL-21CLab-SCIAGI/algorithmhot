import { Link } from "react-router";
import type { LbBoardEntry } from "@aihot/contracts/leaderboard";
import { BrandMark } from "./BrandMark";
import { EvidenceBadge } from "./Evidence";
import { modelHref } from "./format";

// A faint wash of the rank colour from the card's top corner; the number itself carries the rank.
const WASH = [
  "bg-[radial-gradient(130%_100%_at_0%_0%,color-mix(in_srgb,var(--rank-1)_11%,transparent),transparent_62%)]",
  "bg-[radial-gradient(130%_100%_at_0%_0%,color-mix(in_srgb,var(--rank-2)_11%,transparent),transparent_62%)]",
  "bg-[radial-gradient(130%_100%_at_0%_0%,color-mix(in_srgb,var(--rank-3)_12%,transparent),transparent_62%)]",
];
const RANK_TEXT = ["text-rank-1", "text-rank-2", "text-rank-3"];

/**
 * The top three above the full table, kept short so the table starts high. Two rows: the rank with its
 * evidence, then who the model is beside the consensus index.
 */
export function Podium({ entries, board }: { entries: LbBoardEntry[]; board: string }) {
  const top = entries.filter((e) => e.rank <= 3).slice(0, 3);
  if (top.length < 3) return null;
  return (
    <ol className="mt-3 hidden gap-3 md:grid md:grid-cols-3" aria-label="前三名">
      {top.map((e, i) => (
        <li key={e.model.slug}>
          <Link to={modelHref(e.model.slug, board)} prefetch="intent" className={`card card-hover group flex h-full flex-col px-4 py-3.5 ${WASH[i]}`}>
            <span className="flex items-center justify-between gap-3">
              <span className={`mono text-[11px] font-bold tracking-[0.16em] ${RANK_TEXT[i]}`}>NO.{String(e.rank).padStart(2, "0")}</span>
              <span className="flex items-center gap-2 text-[11.5px] text-ink-4">
                <span className="num">{e.sourceCount} 项评测</span>
                <EvidenceBadge confidence={e.confidence} stability={e.stability} rank={e.rank} />
              </span>
            </span>
            <span className="mt-2.5 flex items-center gap-3">
              <BrandMark brand={e.model.brand} size={34} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15.5px] font-[650] leading-snug text-ink transition-colors group-hover:text-accent">{e.model.name}</span>
                <span className="block truncate text-[12px] text-ink-4">{e.model.provider ?? "—"}</span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-[11px] leading-none text-ink-4">共识指数</span>
                <span className="mono mt-1 block text-[26px] font-semibold leading-none tracking-[-0.03em] text-ink">{e.score.toFixed(1)}</span>
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
