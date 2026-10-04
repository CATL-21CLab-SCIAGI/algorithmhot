import assert from "node:assert/strict";
import { test } from "node:test";
import { originalLink } from "../app/lib/original-link.ts";

test("original article links preserve the source path, version, query and fragment", () => {
  const source = "https://arxiv.org/abs/2609.12345v2?context=cs#abstract";
  assert.equal(originalLink(source), source);
  assert.equal(originalLink("http://example.org/paper"), "http://example.org/paper");
});

test("unknown, relative, executable and credential-bearing originals never become links", () => {
  for (const value of [undefined, null, "", "   ", 42, {}, "/items/paper", "javascript:alert(1)", "data:text/html,hello", "file:///private/local", "https://user:password@example.org/paper"])
    assert.equal(originalLink(value), null);
});
