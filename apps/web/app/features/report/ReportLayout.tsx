import type { ReactNode } from "react";
import type { ReportNavigationEntry, ReportKind } from "@aihot/contracts/site";
import { ReportArchive, ReportPhoneNav } from "./ReportNav";

/**
 * Report pages sit beside their own archive column (desktop), flush against the site sidebar; phones
 * get the kind tabs and recent issues above the page instead. The paper is centred beside the archive,
 * on white in the light theme, up to 1160px.
 */
export function ReportLayout({ kind, index, current, today, children }: { kind: ReportKind; index: ReportNavigationEntry[]; current: string | null; today: string; children: ReactNode }) {
  return (
    <div className="report-shell lg:-mx-7 lg:-mb-[72px] lg:-mt-6 lg:flex lg:min-h-dvh">
      <ReportArchive kind={kind} index={index} current={current} />
      <div className="min-w-0 flex-1 pb-6 lg:flex lg:flex-col lg:items-center lg:px-10 lg:pb-16 lg:pt-9">
        <ReportPhoneNav kind={kind} index={index} current={current} today={today} />
        <div className="w-full lg:max-w-[1160px]">{children}</div>
      </div>
    </div>
  );
}
