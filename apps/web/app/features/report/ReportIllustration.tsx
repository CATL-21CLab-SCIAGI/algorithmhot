import { useState } from "react";
import type { ReportCitation } from "@aihot/contracts/site";
import { PAPER_FIGURES } from "@aihot/industry/paper-figures";
import { IconExternal } from "../../components/icons";

/** Original source figures only. Review binds the image to the edition's source revision. */
export function ReportIllustration({ citation, priority = false }: { citation: ReportCitation; priority?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!citation.available || !citation.itemId) return null;
  const revision = citation.researchBrief?.sourceRevision ?? citation.researchRoadmap?.sourceRevision;
  const candidate = citation.paperFigure;
  const figure = candidate?.itemId === citation.itemId && candidate.sourceRevision === revision ? candidate : PAPER_FIGURES.find(f => f.itemId === citation.itemId && f.sourceRevision === revision);
  if (!figure) return <a href={citation.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex text-[12px] text-accent hover:underline">查看论文图表 ↗</a>;
  return <figure data-paper-figure="true" data-item-id={citation.itemId} data-source-revision={figure.sourceRevision}
    className="my-4 overflow-hidden rounded-panel border border-line bg-bg-sunk/45">
    <div className="flex items-center justify-between gap-3 px-3 py-2 text-[11px] text-ink-4">
      <span className="font-medium">{figure.figureLabel}</span>
      <a href={figure.imageUrl} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 text-accent hover:underline">查看大图<IconExternal size={12} /></a>
    </div>
    {failedUrl === figure.imageUrl ? <p className="border-y border-line px-3 py-5 text-[12px] text-ink-3">来源图片暂时无法加载，请点击“原图出处”查看。</p> :
      <a href={figure.imageUrl} target="_blank" rel="noopener noreferrer" aria-label={`查看大图：${citation.title}，${figure.figureLabel}`} className="block border-y border-line bg-white p-2">
        <img data-paper-figure={citation.itemId} src={figure.imageUrl} width={figure.width} height={figure.height}
          alt={`${figure.figureLabel}：${figure.caption}`} loading={priority ? "eager" : "lazy"} fetchPriority={priority ? "high" : "auto"} decoding="async" referrerPolicy="no-referrer"
          onError={() => setFailedUrl(figure.imageUrl)} className="block h-auto w-full object-contain" />
      </a>}
    <figcaption className="space-y-1 px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-3">
      <p><span className="font-medium">{figure.figureLabel} · </span>{figure.caption}</p>
      <p className="text-[10.5px] text-ink-4">{figure.attribution} · <a href={figure.licenseUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{figure.licenseName}</a></p>
      <p><a href={figure.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">原图出处 ↗</a></p>
    </figcaption>
  </figure>;
}
