import { IconExternal } from "./icons";
import { originalLink } from "../lib/original-link";

/** Above stretched card links so this control always opens the source directly. */
export function OriginalSourceLink({ url, title, className = "", label = "打开原文" }: { url: string | null | undefined; title?: string; className?: string; label?: string }) {
  const href = originalLink(url);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={title ? `${label}：${title}` : label}
      className={`relative z-10 inline-flex min-h-7 shrink-0 items-center gap-1 text-[12px] font-medium text-accent transition-colors hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${className}`}>
      {label}<IconExternal size={13} />
    </a>
  );
}
