// Offline validation of the research pack. Does not collect sources or call a model.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { CATEGORIES, TOPIC_TAGS, ENTITY_TAGS, CATEGORY_TAGS } from './taxonomy.ts';
import { SITE } from './site.ts';
import { FEATURES } from './features.ts';
import { SELECTION } from './selection.ts';
import { assertSupportedConfig } from '../packages/backend/src/sources/config-keys.ts';
import { promptText } from '../packages/backend/src/editorial/prompts.ts';

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
const { sources } = JSON.parse(read('./sources.json'));
assert.deepEqual(CATEGORIES.map(c => c.key), ['algorithm', 'ai4ai', 'ai4s']);
assert.equal(SITE.name, 'AlgorithmHot · 科研热点');
assert.equal(SITE.mcpPrefix, 'algorithmhot');
assert.equal(SITE.crawlerName, 'algorithmhot');
assert.deepEqual(FEATURES, { leaderboard: false, codexResetMonitor: false });
assert.deepEqual(SELECTION.thresholds, { T1: 60, T1_5: 65, T2: 76 });
assert.equal(SELECTION.understandFloor, 50);
assert.equal(sources.length, 6);
assert.equal(new Set(sources.map(s => s.id)).size, 6);
assert.equal(sources.filter(s => s.config.researchSourceKind === 'arxiv').length, 3);
assert.equal(sources.filter(s => s.participation_mode === 'hot_signal').length, 1);
for (const source of sources) {
  assertSupportedConfig(source.kind, source.config);
  assert.equal(source.enabled, false, `${source.id} must start disabled`);
  assert.equal(source.site_fulltext, false);
  assert.equal(source.syndicate_fulltext, false);
  assert.equal(source.interval_minutes, 360);
  assert.equal(source.config.fixedInterval, true);
  if (source.config.researchSourceKind === 'arxiv') {
    assert.equal(source.config.summaryIsBody, true);
    assert.equal(source.config.fetchPublicContent, false);
  }
}
const { topics, groups } = JSON.parse(read('./topics.json'));
const slugs = new Set(topics.map(t => t.slug));
const groupKeys = new Set(groups.map(g => g.key));
const tags = new Set([...TOPIC_TAGS, ...ENTITY_TAGS, ...CATEGORY_TAGS]);
assert.equal(slugs.size, topics.length);
for (const topic of topics) {
  assert(groupKeys.has(topic.group), `${topic.slug}: unknown group`);
  for (const related of topic.related) assert(slugs.has(related), `${topic.slug}: dangling related topic ${related}`);
  for (const tag of topic.tags) assert(tag.startsWith('entity:') || tags.has(tag), `${topic.slug}: unknown tag ${tag}`);
}
const files = readdirSync(new URL('./prompts', import.meta.url)).filter(name => name.endsWith('.md'));
const values = {};
for (const file of files) for (const match of read(`./prompts/${file}`).matchAll(/\{\{([A-Za-z][\w.-]*)\s*\}\}/g)) values[match[1]] = 'validation';
values.siteName = SITE.name;
for (const file of files) assert(!/\{\{/.test(promptText(file.slice(0, -3), values)), `${file}: unresolved template`);
const score = read('./prompts/selection-score.md');
const rows = [...score.matchAll(/^\| (\w+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \|$/gm)].map(m => [m[1], ...m.slice(2).map(Number)]);
assert.deepEqual(rows, [
  ['model_release',3,2,2,2,1], ['product_launch',2,2,1,2,3], ['tool_or_prompt',1,2,1,2,4],
  ['research_paper',5,3,1,0,1], ['industry_event',3,1,2,4,0], ['opinion_analysis',1,3,1,4,1], ['tutorial_explainer',1,1,1,3,4],
]);
for (const name of ['daily', 'weekly', 'monthly', 'archive']) {
  const svg = read(`./brand/nameplates/${name}.svg`);
  assert(svg.includes('id="accent"') && svg.includes('id="ink"'), `${name}: missing themed glyphs`);
  assert(svg.includes('科研'));
}
console.log(JSON.stringify({ status: 'PASS', sources: sources.length, categories: CATEGORIES.length, topics: topics.length, prompts: files.length, modelCalls: 0 }));
