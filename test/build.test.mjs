// Builds a copy of example/ with the test engine and checks the output, then breaks the copy in the ways the build
// must catch. The map and every other engine test themselves through the same calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { build, check, i18n, loadEngine } from '../src/index.mjs';
import plain from './engines/plain.mjs';

const EXAMPLE = fileURLToPath(new URL('../example/', import.meta.url));
const quiet = () => {};
const copy = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kitap-')); fs.cpSync(EXAMPLE, root, { recursive: true }); return root; };
const make = (root, opts = {}) => build({ root, log: quiet, engine: plain, localAssets: true, ...opts });
const read = (root, f) => fs.readFileSync(path.join(root, f), 'utf8');
const bundleOf = root => { const js = read(root, 'dist/first-story/story.js'); return JSON.parse(js.slice('const BUNDLE = '.length, js.lastIndexOf(';'))); };
const edit = (root, file, from, to) => fs.writeFileSync(path.join(root, file), read(root, file).replace(from, to));

test('a book builds every page in every language with the engine in its viewport', async () => {
  const root = copy(), lines = [];
  const r = await make(root, { log: l => lines.push(l) });
  assert.deepEqual(r.stories.map(s => [s.id, s.pages]), [['first-story', 2]]);
  const B = bundleOf(root);
  assert.equal(B.engine, 'plain');
  assert.deepEqual(B.plain, { tint: 'blue', count: 2 });
  assert.deepEqual(B.pages[0].plain, { note: null, things: ['apple'] });
  assert.deepEqual(B.credits, ['The plain engine']);
  assert.deepEqual(B.site.ask, ['chatgpt', 'claude']);
  assert.equal(B.ui.en.hint, 'Just read.', 'the engine lays its strings over the book\'s');
  assert.equal(B.ui.en.prev, 'Prev');
  const html = read(root, 'dist/first-story/en/one/index.html');
  assert.ok(html.includes('<script src="../plain.js?v=') && html.includes('<script src="../kitap.js?v='));
  assert.ok(html.includes('<span class="place" data-thing="apple" tabindex="0">apple</span>'), 'a link in the text takes the engine\'s attribute');
  assert.ok(fs.existsSync(path.join(root, 'dist/plain.js')) && fs.existsSync(path.join(root, 'dist/kitap.js')));
  assert.ok(fs.existsSync(path.join(root, 'dist/vendor/fonts.css')));
  assert.ok(read(root, 'dist/first-story/en.md').includes('# The first story'));
  assert.deepEqual(check({ root, story: 'first-story', engine: plain }), []);
});

test('a field the engine does not know fails naming the file and the field, and a flat engine field is lifted under its key', async () => {
  const root = copy();
  edit(root, 'content/first-story/pages/020-two/page.yaml', 'plain: { note: hello }', 'note: hello');
  await make(root);
  assert.equal(bundleOf(root).pages[1].plain.note, 'hello');
  edit(root, 'content/first-story/pages/020-two/page.yaml', 'note: hello', 'nothing: here');
  await assert.rejects(make(root), /020-two\/page\.yaml:\n  \(root\): Unrecognized key: "nothing"/);
});

test('a link to something the page does not hold fails with the engine\'s words', async () => {
  const root = copy();
  edit(root, 'content/first-story/pages/010-one/text/en.md', '(@apple)', '(@pear)');
  await assert.rejects(make(root), /010-one\/text\/en\.md: \[apple\]\(@pear\) links to "pear", which the page's things do not hold/);
});

test('site.yaml names the engine, which resolves from plugins/engines/ or fails naming both places', async () => {
  const root = copy();
  await assert.rejects(build({ root, log: quiet, localAssets: true }), /engine "plain" is not installed: npm install @openbooknetwork\/plain, or add plugins\/engines\/plain\.mjs/);
  fs.mkdirSync(path.join(root, 'plugins/engines'), { recursive: true });
  fs.cpSync(fileURLToPath(new URL('./engines/', import.meta.url)), path.join(root, 'plugins/engines/'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plugins/engines/plain.mjs'), read(root, 'plugins/engines/plain.mjs').replace("'../../src/index.mjs'", JSON.stringify(fileURLToPath(new URL('../src/index.mjs', import.meta.url)))));
  const r = await build({ root, log: quiet, localAssets: true });
  assert.equal(r.stories.length, 1);
  assert.equal(loadEngine(root, 'plain').id, 'plain');
});

test('i18n writes the story catalogue with the engine\'s labels and the site catalogue', async () => {
  const root = copy();
  edit(root, 'content/first-story/story.yaml', 'languages: [en]', 'languages: [en, tr]');
  fs.copyFileSync(path.join(root, 'content/first-story/pages/010-one/text/en.md'), path.join(root, 'content/first-story/pages/010-one/text/tr.md'));
  fs.copyFileSync(path.join(root, 'content/first-story/pages/020-two/text/en.md'), path.join(root, 'content/first-story/pages/020-two/text/tr.md'));
  const written = i18n({ root, lang: 'tr', log: quiet, engine: plain });
  assert.ok(written.some(f => f.endsWith('content/first-story/i18n/tr.yaml')));
  const cat = read(root, 'content/first-story/i18n/tr.yaml');
  assert.ok(cat.includes('pages.one.title: ""') && cat.includes('story.title: ""'));
});
