import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { destination } from "../scripts/pages-publisher.ts";
import { verifyPublishedSite, type VerificationDependencies, type VerificationOptions, type VerificationReceipt } from "../scripts/daily-delivery/verify.ts";

const repo = "example/research", base = destination(repo).base, sha = "a".repeat(40);
const generatedAt = "2026-10-07T04:34:08.868Z", cutoff = "2026-10-07T04:29:09.019Z", start = "2026-10-06T00:00:00.000Z";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
interface Fixture {
  directory: string; options: VerificationOptions; files: Record<string, string>; publisher: Record<string, unknown>;
  delivery: Record<string, unknown>; snapshot: { schemaVersion: number; generatedAt: string; publicBaseUrl: string; items: { category: string }[]; topics: { slug: string }[]; reports: { kind: string; key: string; status: string; revision: number; windowStart: string; windowEnd: string }[] };
  save(): Promise<void>;
}
async function fixture(action: (value: Fixture) => Promise<void>, target = "2026-10-07-12"): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "algorithmhot-verify-"));
  const source = path.join(directory, "public"), stateDir = path.join(directory, "private"), publisherReceiptPath = path.join(directory, "publisher.json");
  const windowEnd = target.length > 10 ? cutoff : "2026-10-07T00:00:00.000Z";
  const snapshot = { schemaVersion: 1, generatedAt, publicBaseUrl: base, items: [{ category: "algorithm" }], topics: [{ slug: "papers" }],
    reports: [{ kind: "daily", key: "2026-10-07", status: "partial", revision: 3, windowStart: start, windowEnd }] };
  const files: Record<string, string> = { ".nojekyll": "", "assets/site.css": "body { color: black; }" };
  for (const route of ["index.html", "hot/index.html", "hot/page/2/index.html", "all/index.html", "all/page/2/index.html", "all/page/3/index.html", "category/algorithm/index.html",
    "all/category/algorithm/index.html", "all/category/algorithm/page/2/index.html", "topics/index.html", "topics/papers/index.html", "topics/papers/page/2/index.html",
    "daily/index.html", "daily/archive/index.html", "daily/2026-10-07/index.html"]) files[route] = `<!doctype html><h1>${route}</h1>`;
  const publisher = { repo, branch: "gh-pages", revision: sha, publicBaseUrl: base, exportedAt: generatedAt, state: "remote-ref-verified" };
  const delivery = { version: 1, date: target, runId: `${target.length > 10 ? "refresh" : "daily"}-${target}`, repo, siteBase: base, windowStart: start, windowEnd,
    inspection: { report: { status: "partial", revision: 3 } } };
  const value: Fixture = { directory, options: { target, repo, source, stateDir, publisherReceiptPath, maxAttempts: 3, intervalMs: 20, maxDurationMs: 1000 }, files, publisher, delivery, snapshot,
    save: async () => {
      files["data/snapshot.json"] = JSON.stringify(snapshot);
      files["export-manifest.json"] = JSON.stringify({ schemaVersion: 1, generatedAt, publicBaseUrl: base,
        files: Object.entries(files).filter(([file]) => file !== "export-manifest.json").map(([file, text]) => ({ path: file, bytes: Buffer.byteLength(text), sha256: digest(text) })) });
      await rm(source, { recursive: true, force: true });
      for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(source, file)), { recursive: true }); await writeFile(path.join(source, file), text); }
      await mkdir(stateDir, { recursive: true });
      await writeFile(publisherReceiptPath, JSON.stringify(publisher));
      await writeFile(path.join(stateDir, `${target}.json`), JSON.stringify(delivery));
    } };
  try { await value.save(); await action(value); } finally { await rm(directory, { recursive: true, force: true }); }
}
type Override = (request: { url: URL; round: number; file: string | null }) => Response | undefined;
function network(value: Fixture, override: Override = () => undefined) {
  const visited: string[] = [], sleeps: number[] = [];
  let clock = Date.parse(generatedAt) + 1000, round = 0, active = 0, peak = 0;
  const deps: VerificationDependencies = {
    now: () => new Date(clock), sleep: async milliseconds => { sleeps.push(milliseconds); clock += milliseconds; },
    fetch: async (input, init) => {
      const url = new URL(String(input)); visited.push(url.href);
      assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit");
      assert.equal(new Headers(init?.headers).has("authorization"), false); assert.equal(url.username, ""); assert.equal(url.password, "");
      if (url.pathname.endsWith("/git/ref/heads/gh-pages")) round++;
      let file: string | null = null;
      if (url.origin === new URL(base).origin) {
        assert.ok(url.href.startsWith(base)); file = url.pathname.slice(new URL(base).pathname.length);
        if (!file || file.endsWith("/")) file += "index.html";
      }
      active++; peak = Math.max(peak, active);
      try {
        await setImmediate();
        const result = override({ url, round, file }); if (result) return result;
        if (url.pathname.endsWith("/git/ref/heads/gh-pages")) return Response.json({ object: { type: "commit", sha } });
        if (url.pathname.endsWith("/actions/runs")) {
          assert.equal(url.searchParams.get("branch"), "gh-pages"); assert.equal(url.searchParams.get("head_sha"), sha);
          return Response.json({ workflow_runs: [{ id: 10, name: "pages build and deployment", head_sha: sha, head_branch: "gh-pages", status: "completed", conclusion: "success" }] });
        }
        assert.ok(file && file in value.files, `Unexpected public file request: ${file}`);
        return new Response(value.files[file!]);
      } finally { active--; }
    },
  };
  return { deps, visited, sleeps, peak: () => peak };
}
const receipt = async (value: Fixture): Promise<VerificationReceipt> => JSON.parse(await readFile(path.join(value.options.stateDir!, "verification", `${value.options.target}-automatic.json`), "utf8"));

test("verifies all exported pagination, category, topic, report and data files with at most four public requests", async () => {
  await fixture(async value => {
    const remote = network(value), result = await verifyPublishedSite(value.options, remote.deps);
    assert.equal(result.status, "PASS"); assert.equal(result.report?.status, "partial"); assert.equal(result.report?.revision, 3);
    assert.equal(result.revision, sha); assert.equal(result.counts?.files, Object.keys(value.files).length - 1);
    assert.equal(result.counts?.html, 15); assert.equal(result.counts?.excludedDeploymentMarkers, 1);
    assert.equal(result.attempts[0].filesMatched, result.counts?.files); assert.equal(remote.peak(), 4);
    for (const file of Object.keys(value.files).filter(file => file !== ".nojekyll")) assert.ok(remote.visited.includes(new URL(file.replace(/index\.html$/, ""), base).href), file);
    assert.equal(remote.visited.some(url => url.includes(".nojekyll")), false);
    assert.equal((await receipt(value)).status, "PASS"); assert.equal((await stat(result.receiptPath)).mode & 0o777, 0o600);
  });
});

test("old remote manifest and mismatched snapshot remain WAIT with every failed attempt preserved", async () => {
  await fixture(async value => {
    const remote = network(value, ({ round, file }) => round === 1 && file === "export-manifest.json" ? new Response("old export")
      : round === 2 && file === "data/snapshot.json" ? new Response("old snapshot") : undefined);
    const result = await verifyPublishedSite(value.options, remote.deps);
    assert.deepEqual(result.attempts.map(attempt => attempt.status), ["WAIT", "WAIT", "PASS"]);
    assert.equal(result.attempts[0].issues[0].path, "export-manifest.json"); assert.equal(result.attempts[1].issues[0].path, "data/snapshot.json");
    assert.deepEqual(remote.sleeps, [20, 20]); assert.equal((await receipt(value)).attempts.length, 3);
  });
});

test("a stale third page fails the complete bundle even when homepage and snapshot match", async () => {
  await fixture(async value => {
    const remote = network(value, ({ file }) => file === "all/page/3/index.html" ? new Response("stale third page") : undefined);
    await assert.rejects(verifyPublishedSite(value.options, remote.deps), /VERIFICATION_ATTEMPTS_EXHAUSTED/);
    const result = await receipt(value); assert.equal(result.status, "FAIL"); assert.equal(result.attempts.length, 3);
    assert.equal(result.attempts[0].filesChecked, result.counts!.files); assert.equal(result.attempts[0].filesMatched, result.counts!.files - 1);
    assert.deepEqual(result.attempts[0].issues, [{ check: "file", code: "CONTENT_MISMATCH", path: "all/page/3/index.html" }]);
  });
});

test("missing files and pending matching Pages builds may settle, but a failed build stops immediately", async () => {
  await fixture(async value => {
    const remote = network(value, ({ round, url, file }) => round === 1 && url.pathname.endsWith("/actions/runs")
      ? Response.json({ workflow_runs: [{ id: 10, name: "pages build and deployment", head_sha: sha, head_branch: "gh-pages", status: "in_progress", conclusion: null }] })
      : round === 2 && file === "hot/page/2/index.html" ? new Response("", { status: 404 }) : undefined);
    const result = await verifyPublishedSite(value.options, remote.deps);
    assert.equal(result.attempts[0].issues[0].code, "PAGES_BUILD_PENDING"); assert.equal(result.attempts[1].issues[0].httpStatus, 404); assert.equal(result.status, "PASS");
    const failed = network(value, ({ url }) => url.pathname.endsWith("/actions/runs")
      ? Response.json({ workflow_runs: [{ id: 11, name: "pages build and deployment", head_sha: sha, head_branch: "gh-pages", status: "completed", conclusion: "failure" }] }) : undefined);
    await assert.rejects(verifyPublishedSite(value.options, failed.deps), /PAGES_BUILD_FAILED/);
    assert.equal((await receipt(value)).attempts.length, 1); assert.deepEqual(failed.sleeps, []);
    assert.equal(failed.visited.filter(url => url.startsWith(base)).length, 0);
  });
});

test("remote SHA and Pages build SHA must both match the publisher receipt", async () => {
  for (const mismatch of ["ref", "build"]) await fixture(async value => {
    const remote = network(value, ({ url }) => mismatch === "ref" && url.pathname.endsWith("/git/ref/heads/gh-pages")
      ? Response.json({ object: { type: "commit", sha: "b".repeat(40) } }) : mismatch === "build" && url.pathname.endsWith("/actions/runs")
        ? Response.json({ workflow_runs: [{ id: 10, name: "pages build and deployment", head_sha: "b".repeat(40), head_branch: "gh-pages", status: "completed", conclusion: "success" }] }) : undefined);
    await assert.rejects(verifyPublishedSite({ ...value.options, maxAttempts: 1 }, remote.deps), /VERIFICATION_ATTEMPTS_EXHAUSTED/);
    assert.equal((await receipt(value)).attempts[0].issues[0].code, mismatch === "ref" ? "REMOTE_COMMIT_MISMATCH" : "PAGES_BUILD_NOT_FOUND");
    assert.equal(remote.visited.filter(url => url.startsWith(base)).length, 0);
  });
});

test("publisher identity, snapshot identity and exact delivery window/revision fail before any network call", async () => {
  for (const mutate of [
    (value: Fixture) => { value.publisher.revision = "not-a-commit"; },
    (value: Fixture) => { value.publisher.repo = "other/repo"; },
    (value: Fixture) => { value.publisher.exportedAt = "2026-10-07T01:00:00.000Z"; },
    (value: Fixture) => { value.publisher.publicBaseUrl = "https://other.github.io/repo/"; },
    (value: Fixture) => { value.snapshot.generatedAt = "2026-10-07T01:00:00.000Z"; },
    (value: Fixture) => { value.snapshot.reports[0].windowEnd = "2026-10-07T07:30:00.000Z"; },
    (value: Fixture) => { value.snapshot.reports[0].revision = 4; },
    (value: Fixture) => { value.snapshot.reports[0].key = "2026-10-06"; },
    (value: Fixture) => { delete value.files["daily/index.html"]; },
    (value: Fixture) => { value.files["index.html"] = "<p>DATABASE_URL=private-value</p>"; },
  ]) await fixture(async value => {
    mutate(value); await value.save(); const remote = network(value);
    await assert.rejects(verifyPublishedSite(value.options, remote.deps), /LOCAL_EXPORT_OR_PUBLISHER_RECEIPT_INVALID/);
    assert.equal(remote.visited.length, 0); const result = await receipt(value); assert.equal(result.status, "FAIL");
    assert.equal(JSON.stringify(result).includes("private-value"), false);
  });
});

test("date mode supports legacy daily deliveries and retries preserve automatic and manual evidence", async () => {
  await fixture(async value => {
    const directory = path.join(value.options.stateDir!, "verification"); await mkdir(directory);
    const manualPath = path.join(directory, `${value.options.target}-pages.json`); await writeFile(manualPath, "manual evidence");
    const first = network(value, ({ file }) => file ? new Response("unavailable", { status: 503 }) : undefined);
    await assert.rejects(verifyPublishedSite({ ...value.options, maxAttempts: 1 }, first.deps));
    const failedReceipt = await receipt(value);
    const second = network(value); await verifyPublishedSite(value.options, second.deps);
    assert.equal(await readFile(manualPath, "utf8"), "manual evidence");
    const archived = (await readdir(directory)).find(file => /-automatic-[\w-]+\.json$/.test(file)); assert.ok(archived);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, archived), "utf8")), failedReceipt);
    assert.equal((await receipt(value)).status, "PASS");
  }, "2026-10-07");
});

test("public API denials are terminal without authenticated fallback and network exception contents stay private", async () => {
  await fixture(async value => {
    const denied = network(value, () => new Response("private raw response", { status: 403 }));
    await assert.rejects(verifyPublishedSite(value.options, denied.deps), /PUBLIC_CHECK_FAILED/);
    assert.equal((await receipt(value)).attempts.length, 1); assert.equal(JSON.stringify(await receipt(value)).includes("private raw response"), false);
    const broken = network(value); broken.deps.fetch = async () => { throw new Error("credential-secret-provider-response"); };
    await assert.rejects(verifyPublishedSite({ ...value.options, maxAttempts: 1 }, broken.deps));
    const result = await receipt(value); assert.equal(result.attempts[0].issues[0].code, "NETWORK_ERROR"); assert.equal(JSON.stringify(result).includes("credential-secret"), false);
  });
});

test("deadline is bounded even while the public build remains pending", async () => {
  await fixture(async value => {
    const remote = network(value, ({ url }) => url.pathname.endsWith("/actions/runs") ? Response.json({ workflow_runs: [] }) : undefined);
    await assert.rejects(verifyPublishedSite({ ...value.options, maxDurationMs: 25 }, remote.deps), /VERIFICATION_DEADLINE/);
    assert.deepEqual(remote.sleeps, [20, 5]); assert.equal((await receipt(value)).attempts.length, 2);
  });
});
