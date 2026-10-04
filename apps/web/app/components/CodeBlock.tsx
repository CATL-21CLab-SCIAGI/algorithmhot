import { useEffect, useRef, useState } from "react";
import { IconCheck, IconCopy } from "./icons";
import { copyText } from "../lib/clipboard";

export function CopyButton({ text, label = "复制", className = "" }: { text: string; label?: string; className?: string }) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);
  const copied = status === "copied";
  const visibleLabel = copied ? "已复制" : status === "failed" ? "复制失败，请手动选择" : status === "copying" ? "复制中…" : label;
  return (
    <button
      type="button"
      aria-disabled={status === "copying"}
      aria-busy={status === "copying"}
      onClick={async () => {
        if (status === "copying") return;
        if (resetTimer.current) clearTimeout(resetTimer.current);
        setStatus("copying");
        const succeeded = await copyText(text);
        if (!mounted.current) return;
        setStatus(succeeded ? "copied" : "failed");
        if (succeeded) resetTimer.current = setTimeout(() => setStatus("idle"), 1500);
      }}
      className={`inline-flex min-h-7 items-center gap-1 rounded-mark border border-line bg-surface px-2 text-[12px] transition-colors ${copied ? "text-ok" : status === "failed" ? "text-hot" : "text-ink-3 hover:border-line-strong hover:text-ink"} ${className}`}
      aria-label={visibleLabel}
      aria-live="polite"
    >
      <span key={copied ? "ok" : "copy"} className={copied ? "anim-swap-in" : ""}>
        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </span>
      {visibleLabel}
    </button>
  );
}

/** Code panel on the page's quiet grey, with a copy button; `lang` is only a label. */
export function CodeBlock({ code, lang, title }: { code: string; lang?: string; title?: string }) {
  return (
    <div className="my-4 overflow-hidden rounded-card border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line-soft px-4 py-2">
        <span className="text-[12px] text-ink-4">{title ?? lang ?? ""}</span>
        <CopyButton text={code} />
      </div>
      <pre className="mono overflow-x-auto bg-bg-sunk/60 px-4 py-4 text-[12.5px] leading-[1.75] text-ink-2 dark:bg-bg-muted/40">
        <code>{code}</code>
      </pre>
    </div>
  );
}
