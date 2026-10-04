import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { copyText } from "../app/lib/clipboard.ts";

function browser(t: TestContext, writeText: ((text: string) => Promise<void>) | undefined, fallback: () => boolean) {
  const events: string[] = [];
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const textarea = {
    value: "", readOnly: false, tabIndex: 0, style: {},
    setAttribute(name: string, value: string) { events.push(`${name}:${value}`); },
    focus(options: FocusOptions) { assert.equal(options.preventScroll, true); events.push("focus-textarea"); },
    select() { events.push("select"); },
    remove() { events.push("remove"); },
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: writeText ? { writeText } : undefined } });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      activeElement: { focus(options: FocusOptions) { assert.equal(options.preventScroll, true); events.push("restore-focus"); } },
      createElement(tag: string) { assert.equal(tag, "textarea"); events.push("create"); return textarea; },
      body: { appendChild(element: unknown) { assert.equal(element, textarea); events.push("append"); } },
      execCommand(command: string) { assert.equal(command, "copy"); events.push("copy"); return fallback(); },
    },
  });
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  });
  return { events, textarea };
}

const denied = async () => { throw new Error("Clipboard permission denied"); };

test("clipboard success does not invoke the legacy fallback", async (t) => {
  const { events } = browser(t, async (value) => { assert.equal(value, "research config"); }, () => assert.fail("Unexpected fallback"));
  assert.equal(await copyText("research config"), true);
  assert.deepEqual(events, []);
});

test("denied clipboard access can succeed through a hidden fallback and restores focus", async (t) => {
  const { events, textarea } = browser(t, denied, () => true);
  assert.equal(await copyText("research config"), true);
  assert.equal(textarea.value, "research config");
  assert.equal(textarea.readOnly, true);
  assert.equal(textarea.tabIndex, -1);
  assert.deepEqual(textarea.style, { position: "fixed", left: "-9999px", top: "0", opacity: "0" });
  assert.deepEqual(events, ["create", "aria-hidden:true", "append", "focus-textarea", "select", "copy", "remove", "restore-focus"]);
});

test("denied clipboard access and a false fallback report failure and clean up", async (t) => {
  const { events } = browser(t, denied, () => false);
  assert.equal(await copyText("research config"), false);
  assert.deepEqual(events.slice(-3), ["copy", "remove", "restore-focus"]);
});

test("denied clipboard access and a throwing fallback report failure and clean up", async (t) => {
  const { events } = browser(t, denied, () => { throw new Error("Legacy copy denied"); });
  assert.equal(await copyText("research config"), false);
  assert.deepEqual(events.slice(-3), ["copy", "remove", "restore-focus"]);
});

test("missing Clipboard API still uses the legacy success result", async (t) => {
  const { events } = browser(t, undefined, () => true);
  assert.equal(await copyText("research config"), true);
  assert.deepEqual(events.slice(-3), ["copy", "remove", "restore-focus"]);
});
