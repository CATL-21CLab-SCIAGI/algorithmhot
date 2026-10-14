import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { publish, type PublishOptions } from "../publish.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function bareRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "pages-mirror-"));
  const bare = path.join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  return { root, bare, url: pathToFileURL(bare).href };
}

const files = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([k, v]) => [k, Buffer.from(v)]));
const options = (root: string, url: string, over: Partial<PublishOptions> = {}): PublishOptions => ({
  dir: path.join(root, "work"), repo: url, branch: "gh-pages", token: null, author: "Mirror Bot <mirror@example.invalid>",
  files: files({ "index.html": "home", "daily/2026-10-11/index.html": "day", ".nojekyll": "" }), now: new Date("2026-10-12T00:40:00Z"),
  ...over,
});

test("publishes the tree as a new branch, then commits only what changed", async () => {
  const { root, bare, url } = bareRepo();
  const first = await publish(options(root, url));
  assert.equal(first.changed, true);
  assert.ok(first.pushedAt);
  assert.equal(git(bare, "rev-parse", "refs/heads/gh-pages"), first.commit);
  assert.equal(git(bare, "log", "-1", "--format=%an <%ae>|%s", "gh-pages"), "Mirror Bot <mirror@example.invalid>|Mirror 2026-10-12T00:40:00.000Z");
  assert.deepEqual(git(bare, "ls-tree", "-r", "--name-only", "gh-pages").split("\n").sort(), [".nojekyll", "daily/2026-10-11/index.html", "index.html"]);

  const again = await publish(options(root, url, { now: new Date("2026-10-12T01:40:00Z") }));
  assert.deepEqual(again, { commit: first.commit, changed: false, pushedAt: null });
  assert.equal(git(bare, "rev-list", "--count", "gh-pages"), "1");

  const next = await publish(options(root, url, { files: files({ "index.html": "home 2", ".nojekyll": "" }) }));
  assert.equal(next.changed, true);
  assert.equal(git(bare, "rev-list", "--count", "gh-pages"), "2");
  assert.deepEqual(git(bare, "ls-tree", "-r", "--name-only", "gh-pages").split("\n").sort(), [".nojekyll", "index.html"]);
  assert.equal(git(bare, "show", "gh-pages:index.html"), "home 2");
});

test("builds on whatever the remote branch holds now, without force", async () => {
  const { root, bare, url } = bareRepo();
  await publish(options(root, url));
  // Someone else pushes to the branch between runs.
  const other = path.join(root, "other");
  execFileSync("git", ["clone", "-q", "-b", "gh-pages", url, other]);
  writeFileSync(path.join(other, "stray.txt"), "x");
  git(other, "add", "-A");
  git(other, "-c", "user.name=o", "-c", "user.email=o@x", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "stray");
  git(other, "push", "-q", "origin", "gh-pages");
  const theirs = git(bare, "rev-parse", "gh-pages");

  const result = await publish(options(root, url, { now: new Date("2026-10-12T02:40:00Z") }));
  assert.equal(result.changed, true);
  assert.equal(git(bare, "rev-parse", "gh-pages^"), theirs);
  assert.ok(!git(bare, "ls-tree", "-r", "--name-only", "gh-pages").includes("stray.txt"));
});

test("a rejected push is tried once more from the remote's tip; a second rejection fails the run", async () => {
  const { root, bare, url } = bareRepo();
  await publish(options(root, url));
  const hook = path.join(bare, "hooks", "pre-receive");
  const marker = path.join(root, "rejected-once");
  writeFileSync(hook, `#!/bin/sh\nif [ ! -f "${marker}" ]; then touch "${marker}"; echo "moved" >&2; exit 1; fi\nexit 0\n`);
  chmodSync(hook, 0o755);
  const retried = await publish(options(root, url, { files: files({ "index.html": "v2", ".nojekyll": "" }) }));
  assert.equal(retried.changed, true);
  assert.equal(git(bare, "show", "gh-pages:index.html"), "v2");

  writeFileSync(hook, "#!/bin/sh\necho 'always no' >&2\nexit 1\n");
  await assert.rejects(publish(options(root, url, { files: files({ "index.html": "v3", ".nojekyll": "" }) })), /git push failed/);
  assert.equal(git(bare, "show", "gh-pages:index.html"), "v2");
});

test("the token goes to git as a header for the repository's host and is never stored or shown", async () => {
  const seen: Array<string | undefined> = [];
  const server = http.createServer((req, res) => { seen.push(req.headers.authorization); res.writeHead(403).end("no"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const root = mkdtempSync(path.join(tmpdir(), "pages-mirror-"));
    const token = "ghp_testtoken0123456789";
    const repo = `http://127.0.0.1:${(server.address() as AddressInfo).port}/owner/repo.git`;
    const error = await publish(options(root, repo, { token })).then(() => null, (e: Error) => e);
    assert.ok(error);
    assert.ok(!error.message.includes(token));
    assert.ok(seen.includes(`Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`), String(seen));
    const stored = readFileSync(path.join(root, "work", ".git", "config"), "utf8");
    assert.ok(!stored.includes(token) && !/extraheader/i.test(stored));
    assert.ok(existsSync(path.join(root, "work", ".git")));
  } finally {
    server.close();
  }
});
