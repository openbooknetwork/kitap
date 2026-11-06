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
import yaml from 'js-yaml';

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
  assert.equal(B.ui.en.network, 'Part of the {network}');
  const html = read(root, 'dist/first-story/en/one/index.html');
  assert.ok(html.includes('<script src="../plain.js?v=') && html.includes('<script src="../kitap.js?v='));
  for (const f of [html, read(root, 'dist/en/index.html')]) assert.ok(f.includes('id="network-menu" href="https://openbooknetwork.org/"'), 'every page links the network');
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

test('i18n --stale lists what changed since --stamp, by block and by key', async () => {
  const root = copy();
  edit(root, 'content/first-story/story.yaml', 'languages: [en]', 'languages: [en, tr]');
  const page = 'content/first-story/pages/020-two/text/', cat = 'content/first-story/i18n/tr.yaml', staleFile = '.cache/kitap/stale/first-story/tr.yaml';
  const en = ['A second page.', 'It has four blocks.', 'The third one.', 'And the last.'];
  fs.writeFileSync(path.join(root, page, 'en.md'), en.join('\n\n') + '\n');
  fs.writeFileSync(path.join(root, page, 'tr.md'), en.map(b => 'tr ' + b).join('\n\n') + '\n');
  fs.copyFileSync(path.join(root, 'content/first-story/pages/010-one/text/en.md'), path.join(root, 'content/first-story/pages/010-one/text/tr.md'));
  const lines = [], o = { root, lang: 'tr', story: 'first-story', log: l => lines.push(l), engine: plain };
  i18n(o);
  const filled = Object.fromEntries(Object.entries(yaml.load(read(root, cat))).map(([k, v]) => [k, v || `tr ${k}`]));
  fs.writeFileSync(path.join(root, cat), yaml.dump(filled));
  i18n({ ...o, stale: true });
  let list = yaml.load(read(root, staleFile));
  assert.deepEqual(Object.values(list.pages).map(p => p.state), ['unstamped', 'unstamped']);
  assert.ok(list.strings.length > 0 && list.strings.every(s => s.state === 'unstamped'));
  assert.equal(lines.at(-1), `first-story tr: 2 pages and ${list.strings.length} strings unstamped`);
  i18n({ ...o, stamp: true });
  const stamps = yaml.load(read(root, 'content/first-story/i18n/stamps/tr.yaml'));
  assert.equal(stamps.pages.two.length, 4);
  assert.equal(Object.keys(stamps.strings).length, list.strings.length);
  i18n({ ...o, stale: true });
  assert.equal(lines.at(-1), 'first-story tr: up to date');
  assert.ok(!fs.existsSync(path.join(root, staleFile)));
  // the English changes one block, drops one and gains one, and a string loses its translation
  fs.writeFileSync(path.join(root, page, 'en.md'), ['A second page.', 'It has four blocks now.', 'And the last.', 'A new one.'].join('\n\n') + '\n');
  i18n({ ...o, stale: true });
  assert.deepEqual(yaml.load(read(root, staleFile)).strings, []);
  assert.equal(lines.at(-1), 'first-story tr: 3 blocks');
  edit(root, cat, 'tr pages.two.title', '');
  i18n({ ...o, stale: true });
  list = yaml.load(read(root, staleFile));
  assert.deepEqual(Object.keys(list.pages), ['two']);
  assert.deepEqual(list.pages.two.blocks, [
    { at: 2, state: 'changed', en: 'It has four blocks now.', tr: 'tr It has four blocks.' },
    { state: 'removed', tr: 'tr The third one.' },
    { at: 4, state: 'new', en: 'A new one.' },
  ]);
  assert.deepEqual(list.strings, [{ key: 'pages.two.title', file: 'content/first-story/i18n/tr.yaml', state: 'new', en: 'Two' }]);
  assert.equal(lines.at(-1), 'first-story tr: 3 blocks, 1 string');
  // the translation follows, with as many blocks as the English, and the list reads its blocks at the new positions
  fs.writeFileSync(path.join(root, page, 'tr.md'), ['tr A second page.', 'tr It has four blocks now.', 'tr And the last.', 'tr A new one.'].join('\n\n') + '\n');
  i18n({ ...o, stale: true });
  assert.equal(yaml.load(read(root, staleFile)).pages.two.blocks[0].tr, 'tr It has four blocks now.');
  edit(root, cat, 'pages.two.title: ""', 'pages.two.title: "tr Two"');
  i18n({ ...o, stamp: true });
  i18n({ ...o, stale: true });
  assert.equal(lines.at(-1), 'first-story tr: up to date');
  await assert.rejects(async () => i18n({ ...o, stale: true, stamp: true }), /--stale or --stamp, one of them/);
  // without a language, one build covers every language of the story
  edit(root, page + 'en.md', 'A new one.', 'A newer one.');
  i18n({ ...o, lang: undefined, stale: true });
  assert.equal(lines.at(-1), 'first-story tr: 1 block');
  fs.writeFileSync(path.join(root, page, 'tr.md'), ['tr A second page.', 'tr It has four blocks now.', 'tr And the last.', 'tr A newer one.'].join('\n\n') + '\n');
  i18n({ ...o, lang: undefined, stamp: true });
  i18n({ ...o, lang: undefined, stale: true });
  assert.equal(lines.at(-1), 'first-story tr: up to date');
  await assert.rejects(async () => i18n({ ...o, lang: undefined }), /usage: kitap i18n/);
});
