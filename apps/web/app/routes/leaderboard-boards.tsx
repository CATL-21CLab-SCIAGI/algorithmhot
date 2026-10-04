import { SITE, withSubject } from "@aihot/industry/site";
import { Link, Outlet } from "react-router";
import { BoardTabs } from "../features/leaderboard/BoardTabs";
import { IconArrowUpRight } from "../components/icons";

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

/** Shared frame for the overall and category boards; only the board below it changes. */
export default function LeaderboardFrame() {
  const chip = "inline-flex h-8 items-center gap-1 rounded-full border border-line-strong bg-surface px-3.5 text-[12.5px] text-ink-2 transition-colors hover:border-ink-4 hover:text-ink";
  return (
    <div className="pb-10">
      <header className="flex flex-col gap-3 pb-4 pt-5 sm:flex-row sm:items-end sm:justify-between lg:pt-1">
        <div>
          <div className="mono text-[11px] font-semibold tracking-[0.16em] text-accent">{SITE.name.toUpperCase()} LEADERBOARD</div>
          <h1 className="mt-1.5 text-[24px] font-semibold leading-[1.3] text-ink">AI 模型排行榜</h1>
        </div>
        <div className="flex gap-2">
          <Link to="/leaderboard/sources" className={chip}>
            评测来源 <IconArrowUpRight size={13} />
          </Link>
          <Link to="/leaderboard/rules" className={chip}>
            排名怎么算 <IconArrowUpRight size={13} />
          </Link>
        </div>
      </header>
      <div className="-mx-4 px-4 lg:mx-0 lg:px-0">
        <BoardTabs />
      </div>
      <Outlet />
    </div>
  );
}
