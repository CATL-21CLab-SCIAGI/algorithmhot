// Database integration only: fetch is injected and never connects to an external host.
import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { after, before, test } from 'node:test';
import { config } from '@aihot/backend/config';
import { sql, closeDb } from '@aihot/backend/db';
import { collectResearchRun, createResearchRun } from '@aihot/backend/research/collect';
import { researchResponsePath, saveResearchResponse } from '@aihot/backend/research/collect-utils';
import type { GuardedResponse } from '@aihot/backend/lib/http-fetch';

const T = tag();
const sourceId = `test-research-collector-${T}`;
const originalDataDir = config.dataDir;
let folder: string;
const firstDay = '2026-09-26';
const now = new Date('2026-10-03T12:00:00Z');
const candidate = { paper: { id: '2609.19999', title: 'Fixture paper', summary: 'A source abstract.', publishedAt: '2026-09-25T00:00:00Z', submittedOnDailyAt: `${firstDay}T00:00:00Z` } };
const response = (url: string, value: unknown): GuardedResponse => {
  const body = Buffer.from(JSON.stringify(value));
  return { status: 200, url, body, headers: new Headers(), text: () => body.toString('utf8') };
};

before(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'algorithmhot-collector-storage-'));
  config.dataDir = folder;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,config) VALUES(${sourceId},'Research collector fixture','json_list','T2','hot_signal',${sql.json({
    url: 'https://huggingface.co/api/daily_papers', researchSourceKind: 'huggingface', titlePaths: ['paper.title'], summaryPaths: ['paper.summary'],
    summaryIsBody: true, urlTemplate: 'https://huggingface.co/papers/{paper.id}', externalIdPath: 'paper.id',
  })})`;
});
after(async () => { config.dataDir = originalDataDir; await closeDb(); await rm(folder, { recursive: true, force: true }); });

test('a parse failure retains returned records, and later healthy dates do not hide source failure', async () => {
  const id = `collect-failure-${T}`;
  await createResearchRun(id, 'pilot', now);
  await collectResearchRun(id, { sourceIds: [sourceId], fetch: async url => response(url, new URL(url).searchParams.get('date') === firstDay ? [{ paper: { id: '2609.19999' } }] : []) });
  const [failed] = await sql`SELECT * FROM research_fetches WHERE run_id=${id} AND status='failed'`;
  assert.equal(failed.returned_count, 1);
  assert.equal(failed.parsed_count, 0);
  assert.equal(failed.http_status, 200);
  assert.equal((await sql`SELECT health FROM sources WHERE id=${sourceId}`)[0].health, 'degraded');
  const originalBody = await readFile(failed.response_path);
  await collectResearchRun(id, { sourceIds: [sourceId], fetch: async url => response(url, [candidate]) });
  const attempts = await sql`SELECT * FROM research_fetches WHERE run_id=${id} AND url=${failed.url} ORDER BY attempt_number`;
  assert.deepEqual(attempts.map(row => row.status), ['failed', 'ok']);
  assert.deepEqual(attempts.map(row => row.returned_count), [1, 1]);
  assert.deepEqual(attempts.map(row => row.parsed_count), [0, 1]);
  assert.notEqual(attempts[0].response_path, attempts[1].response_path);
  assert.deepEqual(await readFile(failed.response_path), originalBody);
  assert.equal((await sql`SELECT health FROM sources WHERE id=${sourceId}`)[0].health, 'ok');
});

test('a response saved before process interruption keeps its denominator and immutable evidence', async () => {
  const id = `collect-interrupted-${T}`;
  await createResearchRun(id, 'pilot', now);
  const url = `https://huggingface.co/api/daily_papers?date=${firstDay}&limit=100&p=0`;
  const file = researchResponsePath(folder, 'interrupted-attempt-1');
  const observedAt = new Date();
  await sql`INSERT INTO research_fetches(run_id,source_id,url,observed_at,status,http_status,response_path,attempt_number) VALUES(${id},${sourceId},${url},${observedAt},'pending',200,${file},1)`;
  const body = Buffer.from(JSON.stringify([candidate]));
  await saveResearchResponse(file, body, { url, status: 200, observedAt, headers: {} });
  // Simulate stopping after the complete body but before the sidecar was durable.
  await rm(`${file}.json`);
  await collectResearchRun(id, { sourceIds: [sourceId], fetch: async target => response(target, []) });
  const attempts = await sql`SELECT * FROM research_fetches WHERE run_id=${id} AND url=${url} ORDER BY attempt_number`;
  assert.deepEqual(attempts.map(row => [row.status, row.returned_count, row.parsed_count]), [['failed', 1, 1], ['ok', 0, 0]]);
  assert.match(attempts[0].error, /interrupted/);
  assert.deepEqual(await readFile(file), body);
  assert.notEqual(attempts[0].response_path, attempts[1].response_path);
});
