// build --changed against a record of the live site, and the deploy that follows it, on a two story copy of example/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { build, deploy } from '../src/index.mjs';
import plain from './engines/plain.mjs';

const EXAMPLE = fileURLToPath(new URL('../example/', import.meta.url));
const quiet = () => {};
const read = (root, f) => fs.readFileSync(path.join(root, f), 'utf8');
const edit = (root, file, from, to) => fs.writeFileSync(path.join(root, file), read(root, file).replace(from, to));
// example/ with a second story and the site's url, asset store and pages bucket
function twoStories() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kitap-changed-'));
  fs.cpSync(EXAMPLE, root, { recursive: true });
  fs.cpSync(path.join(root, 'content/first-story'), path.join(root, 'content/second-story'), { recursive: true });
  edit(root, 'content/second-story/story.yaml', 'id: first-story', 'id: second-story');
  fs.appendFileSync(path.join(root, 'site.yaml'), 'url: https://book.example.org/\nassets: { url: https://assets.example.org/, bucket: assets, endpoint: https://store.example.org }\npages: { bucket: site }\n');
  return root;
}
// the record a deploy of the build in dist/ writes, served as the live site serves it
const recordOf = root => { const b = JSON.parse(read(root, 'dist/.kitap-build.json')); return { format: 1, stories: Object.fromEntries(b.built.map(r => [r.story, { hash: r.hash, shared: r.shared, card: r.card }])) }; };
const serve = record => async url => (assert.ok(url.startsWith('https://book.example.org/kitap-build.json?t=')), { status: 200, ok: true, json: async () => record });
const built = lines => lines.filter(l => l.startsWith('story ')).map(l => l.slice(6));
const md5 = body => crypto.createHash('md5').update(body).digest('hex');
// a bucket in memory, with the writer kitap deploy uses
function bucket(keys) {
  const objects = new Map(Object.entries(keys).map(([k, body]) => [k, Buffer.from(body)]));
  return { objects, writer: { list: async () => [...objects].map(([key, body]) => ({ key, etag: md5(body) })), put: async (k, body) => { objects.set(k, Buffer.from(body)); }, delete: async k => { objects.delete(k); } } };
}

test('build --changed rebuilds the stories whose inputs differ from the live record, and the main page lists them all', async () => {
  const root = twoStories();
  await build({ root, log: quiet, engine: plain });
  const live = recordOf(root);
  assert.deepEqual(Object.keys(live.stories).sort(), ['first-story', 'second-story']);
  fs.rmSync(path.join(root, 'dist'), { recursive: true });

  let lines = [];
  await build({ root, log: l => lines.push(l), engine: plain, changed: true, get: serve(live) });
  assert.deepEqual(built(lines), []);
  assert.ok(lines.includes('2 of 2 stories match the live site: first-story, second-story'));
  assert.ok(!fs.existsSync(path.join(root, 'dist/first-story')), 'a story the live site holds as it is builds no pages');
  for (const id of ['first-story', 'second-story']) assert.ok(read(root, 'dist/index.html').includes(`"id":"${id}"`), 'the main page lists every story from the record');

  edit(root, 'content/second-story/pages/010-one/text/en.md', /\n?$/, '\nA new line.\n');
  lines = [];
  await build({ root, log: l => lines.push(l), engine: plain, changed: true, get: serve(live) });
  assert.deepEqual(built(lines), ['second-story']);
  const after = JSON.parse(read(root, 'dist/.kitap-build.json'));
  assert.deepEqual(after.built.map(b => b.story), ['second-story']);
  assert.notEqual(after.built[0].hash, live.stories['second-story'].hash);
  assert.deepEqual(after.stories, [['first-story', 'first-story'], ['second-story', 'second-story']]);

  // what every story reads, such as site.yaml, rebuilds every story
  edit(root, 'site.yaml', 'A one story site', 'A two story site');
  lines = [];
  await build({ root, log: l => lines.push(l), engine: plain, changed: true, get: serve(live) });
  assert.deepEqual(built(lines), ['first-story', 'second-story']);
});

test('build --changed builds every story when the live site has no record, and takes no story names', async () => {
  const root = twoStories(), lines = [];
  await build({ root, log: l => lines.push(l), engine: plain, changed: true, get: async () => ({ status: 404, ok: false }) });
  assert.deepEqual(built(lines), ['first-story', 'second-story']);
  assert.ok(lines.includes('https://book.example.org has no build record yet, so every story builds'));
  await assert.rejects(build({ root, log: quiet, engine: plain, changed: true, only: ['first-story'] }), /build --changed picks the stories itself, leave out --only and --story/);
});

test('deploy after build --changed keeps the files of the stories it left unbuilt and writes the live record last', async () => {
  const root = twoStories();
  await build({ root, log: quiet, engine: plain });
  const live = recordOf(root);
  fs.rmSync(path.join(root, 'dist'), { recursive: true });
  edit(root, 'content/second-story/pages/010-one/text/en.md', /\n?$/, '\nA new line.\n');
  await build({ root, log: quiet, engine: plain, changed: true, get: serve(live) });

  const b = bucket({ 'first-story/index.html': 'the live page', 'second-story/old.html': 'a page the story dropped', 'kitap-build.json': JSON.stringify(live) });
  const r = await deploy({ root, log: quiet, progress: quiet, writer: b.writer });
  assert.equal(b.objects.get('first-story/index.html').toString(), 'the live page', 'an unbuilt story keeps its files');
  assert.ok(!b.objects.has('second-story/old.html'), 'a built story loses the files its build no longer writes');
  assert.ok(b.objects.has('second-story/index.html') && b.objects.has('index.html'));
  assert.deepEqual(r.deleted, ['second-story/old.html']);
  const record = JSON.parse(b.objects.get('kitap-build.json'));
  assert.equal(record.stories['first-story'].hash, live.stories['first-story'].hash);
  assert.notEqual(record.stories['second-story'].hash, live.stories['second-story'].hash);
});

test('deploy after a build of named stories puts dist/ up whole and takes the live record down', async () => {
  const root = twoStories();
  await build({ root, log: quiet, engine: plain, only: ['first-story'] });
  assert.ok(!fs.existsSync(path.join(root, 'dist/.kitap-build.json')));
  const b = bucket({ 'kitap-build.json': '{}', 'gone/index.html': 'a story no longer built' });
  await deploy({ root, log: quiet, progress: quiet, writer: b.writer });
  assert.ok(!b.objects.has('kitap-build.json'), 'without a record of this build the next build --changed builds every story');
  assert.ok(!b.objects.has('gone/index.html'));
});
