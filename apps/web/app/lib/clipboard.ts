/** A fulfilled Clipboard API request or a true legacy result is the only success signal. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers and denied Clipboard API access may still allow a user-initiated copy.
  }

  const previousFocus = document.activeElement as HTMLElement | null;
  let textarea: HTMLTextAreaElement | null = null;
  try {
    textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.tabIndex = -1;
    textarea.setAttribute("aria-hidden", "true");
    Object.assign(textarea.style, { position: "fixed", left: "-9999px", top: "0", opacity: "0" });
    document.body.appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    return document.execCommand("copy") === true;
  } catch {
    return false;
  } finally {
    textarea?.remove();
    try {
      previousFocus?.focus?.({ preventScroll: true });
    } catch {
      // The original control may have disappeared while the clipboard request was pending.
    }
  }
}
