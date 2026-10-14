// The run summary the admin's runs page shows (needs the test database: npm test).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import mirror, { lastMirror, mirrorOnce } from "../server.ts";

after(() => closeDb());

test("a run is recorded; a failed one keeps the last pushed commit and fails the job", async () => {
  await sql`DELETE FROM pages_mirror_state`;
  assert.equal(await lastMirror(), null);
  let up = true;
  const server = http.createServer((req, res) => {
    if (!up) { res.writeHead(503).end(); return; }
    if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }).end(`<html><body><a href="/about">关于</a></body></html>`); return; }
    res.writeHead(404, { "content-type": "text/html" }).end("<html><body>不存在</body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bare = path.join(mkdtempSync(path.join(tmpdir(), "pages-mirror-")), "remote.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  Object.assign(process.env, {
    PAGES_MIRROR_ORIGIN: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    PAGES_MIRROR_REPO: pathToFileURL(bare).href,
    PAGES_MIRROR_PRIMARY_URL: "https://hot.example.com",
  });
  try {
    const ok = await mirrorOnce();
    assert.equal(ok.pages, 1);
    assert.equal(ok.changed, true);
    assert.ok(ok.skipped > 0 && ok.skippedPaths.includes("/about"));
    assert.equal(ok.commit, execFileSync("git", ["rev-parse", "gh-pages"], { cwd: bare, encoding: "utf8" }).trim());
    assert.deepEqual(await lastMirror(), ok);
    assert.deepEqual(await mirror.admin!.runs!(), ok);

    up = false;
    await assert.rejects(mirrorOnce(), /home page/);
    const failed = (await lastMirror())!;
    assert.match(failed.error!, /home page/);
    assert.equal(failed.commit, ok.commit);
    assert.equal(failed.pushedAt, ok.pushedAt);
  } finally {
    server.close();
  }
});

test("the schedule runs only when enabled", () => {
  const schedule = mirror.schedules!.find((s) => s.name === "pages-mirror.publish")!;
  assert.equal(schedule.missed, "once");
  const before = process.env.PAGES_MIRROR_ENABLED;
  try {
    process.env.PAGES_MIRROR_ENABLED = "1";
    assert.equal(schedule.when!(), false);
    process.env.PAGES_MIRROR_ENABLED = "true";
    assert.equal(schedule.when!(), true);
  } finally {
    if (before === undefined) delete process.env.PAGES_MIRROR_ENABLED;
    else process.env.PAGES_MIRROR_ENABLED = before;
  }
});
