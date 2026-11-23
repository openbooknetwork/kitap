// Builds a copy of example/ with the test engine and checks the output, then breaks the copy in the ways the build
// must catch. The map and every other engine test themselves through the same calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { build, check, checkTranslation, i18n, loadEngine } from '../src/index.mjs';
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

test('credit: false in site.yaml leaves the kitap note out of the story and the main page', async () => {
  const root = copy();
  await make(root);
  assert.equal(bundleOf(root).site.credit, true);
  assert.ok(read(root, 'dist/en/index.html').includes('"credit":true'));
  fs.appendFileSync(path.join(root, 'site.yaml'), '\ncredit: false\n');
  await make(root);
  assert.equal(bundleOf(root).site.credit, false);
  assert.ok(read(root, 'dist/en/index.html').includes('"credit":false'));
});

test('every theme names red, blue, green, gold and on-accent, from accent and paper where a theme leaves them out', async () => {
  const root = copy();
  const plainSet = '{ paper: "#ffffff", paper2: "#eeeeee", sea: "#dddddd", ink: "#111111", ink2: "#555555", rule: "#cccccc", accent: "#aa0000", panel: "#fafafa", route: "#555555", border: "#777777" }';
  fs.appendFileSync(path.join(root, 'site.yaml'), `\nthemes:\n  bare: { light: ${plainSet}, dark: ${plainSet} }\n`);
  await make(root);
  const html = read(root, 'dist/first-story/en/one/index.html');
  assert.ok(html.includes('--red:#d1453b;--blue:#2a6bd1;--green:#2e8540;--gold:#b07a12;--on-accent:#f7f7f5;'), 'the cool theme gives its own hues');
  const bare = html.slice(html.indexOf(':root[data-palette="bare"]{'));
  assert.ok(bare.includes('--red:#aa0000;--blue:#aa0000;--green:#aa0000;--gold:#aa0000;--on-accent:#ffffff;'), 'a theme without hues draws in its accent');
});

test('levels in site.yaml give every story a level and group the main page by level, each level by title', async () => {
  const root = copy(), story = 'content/first-story/story.yaml';
  fs.appendFileSync(path.join(root, 'site.yaml'), '\nlevels: [beginner, advanced]\n');
  await assert.rejects(make(root), /first-story\/story\.yaml:? ?\n?.*level is missing, site\.yaml lists the levels beginner, advanced/s);
  fs.appendFileSync(path.join(root, story), '\nlevel: expert\n');
  await assert.rejects(make(root), /level is "expert", site\.yaml lists the levels beginner, advanced/);
  edit(root, story, 'level: expert', 'level: advanced');
  await make(root);
  const html = read(root, 'dist/en/index.html');
  assert.ok(html.includes('"levels":[{"id":"beginner","name":{"en":"Beginner"'), 'the main page knows the levels and their names');
  assert.ok(html.includes('"level":"advanced"'), 'a story card carries its level');
  assert.ok(html.includes('<li class="level">Advanced <small>1</small></li>'), 'the page lists a level that has stories under its name');
  assert.ok(!html.includes('<li class="level">Beginner'), 'a level with no story has no heading');
  fs.writeFileSync(path.join(root, 'site.yaml'), read(root, 'site.yaml').replace('levels: [beginner, advanced]', ''));
  await assert.rejects(make(root), /level is "advanced", and site\.yaml lists no levels/);
});

test('follows in story.yaml chains two stories, and follows.js names each one\'s neighbours', async () => {
  const root = copy(), first = 'content/first-story/story.yaml', second = 'content/second-story/story.yaml';
  fs.cpSync(path.join(root, 'content/first-story'), path.join(root, 'content/second-story'), { recursive: true });
  edit(root, second, 'id: first-story', 'id: second-story');
  fs.appendFileSync(path.join(root, second), '\nfollows: nowhere\n');
  await assert.rejects(make(root), /second-story\/story\.yaml.*follows names "nowhere", the stories are first-story, second-story/s);
  edit(root, second, 'follows: nowhere', 'follows: second-story');
  await assert.rejects(make(root), /follows names the story itself/);
  edit(root, second, 'follows: second-story', 'follows: first-story');
  await make(root);
  const js = read(root, 'dist/follows.js'), chain = JSON.parse(js.slice('window.KITAP_FOLLOWS = '.length, js.lastIndexOf(';')));
  assert.equal(chain['first-story'].next.id, 'second-story');
  assert.equal(chain['first-story'].previous, null);
  assert.equal(chain['second-story'].previous.id, 'first-story');
  assert.ok(chain['second-story'].previous.title.en, 'a neighbour carries its title in each language');
  fs.appendFileSync(path.join(root, first), '\nfollows: second-story\n');
  await assert.rejects(make(root), /follows leads back to .* in a circle/);
});

test('draft: true in story.yaml leaves the story out of a build, and --story builds it', async () => {
  const root = copy(), second = 'content/second-story/story.yaml', lines = [];
  fs.cpSync(path.join(root, 'content/first-story'), path.join(root, 'content/second-story'), { recursive: true });
  edit(root, second, 'id: first-story', 'id: second-story');
  fs.appendFileSync(path.join(root, second), '\ndraft: true\n');
  await make(root, { log: l => lines.push(l) });
  assert.ok(lines.includes('left out the draft second-story'), lines.join('\n'));
  assert.ok(!fs.existsSync(path.join(root, 'dist/second-story')), 'a draft has no folder in the site');
  assert.ok(!read(root, 'dist/en/index.html').includes('"id":"second-story"'), 'the main page does not list a draft');
  await make(root, { story: 'second-story' });
  assert.ok(fs.existsSync(path.join(root, 'dist/second-story/index.html')), 'a draft builds when the command names it');
});

test('every language kitap ships has the strings of levels and follows', () => {
  const dir = fileURLToPath(new URL('../src/i18n/', import.meta.url));
  for (const file of fs.readdirSync(dir)) {
    const ui = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const key of ['all_levels', 'follows', 'next_story']) assert.ok(ui[key], `${file} has ${key}`);
    for (const key of ['follows', 'next_story']) assert.ok(ui[key].includes('{story}'), `${file} ${key} names {story}`);
    assert.deepEqual(Object.keys(ui.levels ?? {}), ['beginner', 'intermediate', 'advanced'], `${file} names the three levels`);
  }
});

test('cover_dark in story.yaml gives the card a second cover for a dark screen', async () => {
  const root = copy(), story = 'content/first-story/story.yaml', meta = yaml.load(read(root, story));
  fs.appendFileSync(path.join(root, story), `\ncover_dark: ${meta.cover ?? 'nothing'}\n`);
  if (!meta.cover) return assert.rejects(make(root), /cover_dark is the cover on a dark screen, add cover/);
  await make(root);
  const html = read(root, 'dist/en/index.html');
  assert.ok(/<picture><source srcset="[^"]+" media="\(prefers-color-scheme: dark\)"><img src="[^"]+" alt=""><\/picture>/.test(html), 'the card holds both covers');
  assert.ok(bundleOf(root).coverDark, 'the story knows its dark cover');
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

test('i18n --check compares a story\'s translation with its source, page by page and key by key', async () => {
  const root = copy();
  edit(root, 'content/first-story/story.yaml', 'languages: [en]', 'languages: [en, tr]');
  const one = 'content/first-story/pages/010-one/text/', two = 'content/first-story/pages/020-two/text/', cat = 'content/first-story/i18n/tr.yaml';
  const o = { root, lang: 'tr', story: 'first-story', engine: plain };
  fs.writeFileSync(path.join(root, two, 'en.md'), '## In 1453\n\nThe city fell in 1453, with 80,000 men.\n');
  fs.copyFileSync(path.join(root, one, 'en.md'), path.join(root, one, 'tr.md'));
  i18n({ ...o, log: quiet });
  const keys = Object.keys(yaml.load(read(root, cat)));
  assert.deepEqual(checkTranslation(o), ['pages/020-two: no text/tr.md', `${cat}: ${keys.length} empty, ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', ...' : ''}`]);
  fs.writeFileSync(path.join(root, cat), yaml.dump(Object.fromEntries(keys.map(k => [k, `tr ${k}`]))));
  fs.writeFileSync(path.join(root, two, 'tr.md'), 'Şehir düştü.\n\n80.000 asker.\n\nÜçüncü paragraf.\n');
  assert.deepEqual(checkTranslation(o), [
    'pages/020-two: 3 paragraphs, the en text has 2',
    'pages/020-two: 0 headings, the en text has 1',
    'pages/020-two: 1453 of the en text does not appear',
  ]);
  // the year counts in any script's digits
  fs.writeFileSync(path.join(root, two, 'tr.md'), '## ١٤٥٣\n\nŞehir düştü.\n');
  assert.deepEqual(checkTranslation(o), []);
  await assert.rejects(async () => checkTranslation({ ...o, lang: 'de' }), /add de to languages in story.yaml/);
  await assert.rejects(async () => checkTranslation({ ...o, lang: 'en' }), /default language/);
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

test('kitap check runs the checks of plugins/checks after its own, with the pages the command names marked', () => {
  const root = copy(), dir = path.join(root, 'plugins', 'checks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'words.mjs'), "import fs from 'fs';\nimport path from 'path';\nexport default ({ pages, rel }) => pages.filter(p => p.checked && fs.existsSync(path.join(p.dir, 'page.yaml'))).map(p => `${rel(p.dir)} is read`);\n");
  const all = check({ root, story: 'first-story', engine: plain });
  assert.equal(all.length, 2);
  assert.match(all[0], /^words: content\/first-story\/pages\/.* is read$/);
  assert.equal(check({ root, story: 'first-story', pages: ['one'], engine: plain }).length, 1);
  fs.writeFileSync(path.join(dir, 'advice.mjs'), "export default ({ note }) => { note('weigh this'); return []; };\n");
  const lines = [];
  assert.equal(check({ root, story: 'first-story', engine: plain, log: l => lines.push(l) }).length, 2, 'a note is no problem');
  assert.ok(lines.includes('advice: note: weigh this'));
  fs.rmSync(path.join(dir, 'advice.mjs'));
  fs.writeFileSync(path.join(dir, 'broken.mjs'), 'export const x = 1;\n');
  assert.match(check({ root, story: 'first-story', engine: plain })[0], /plugins\/checks\/broken\.mjs:? ?.*a check exports a function as its default/s);
});

test('a page takes a when before our era, and the order check counts its years backwards', async () => {
  const root = copy(), page = n => `content/first-story/pages/${n}/page.yaml`;
  const add = (n, when) => fs.writeFileSync(path.join(root, page(n)), read(root, page(n)).replace(/^when:.*\n/m, '') + `when: ${when}\n`);
  add('010-one', '-0335-03'); add('020-two', '-0334');
  await make(root);
  assert.equal((await make(root)).stories[0].span.en, '335 BC – 334 BC', 'the span reads the years as BC');
  add('020-two', '-0335-01');
  await assert.rejects(make(root), /020-two starts -0335-01-01, before .*010-one which starts -0335-03-01/s, 'January comes before March inside a year BC');
  add('020-two', '-0336');
  await assert.rejects(make(root), /020-two starts -0336-01-01, before/, '336 BC comes before 335 BC');
  add('020-two', '{ from: -0335-06, to: -0336 }');
  await assert.rejects(make(root), /when\.to is before when\.from/);
  add('010-one', '-335'); add('020-two', '1919');
  await make(root);
});

test('a strict build with noStore runs every check and leaves the store unasked', async () => {
  const root = copy(), lines = [], real = globalThis.fetch;
  fs.appendFileSync(path.join(root, 'site.yaml'), 'assets: { url: https://assets.example.org/, bucket: assets, endpoint: https://store.example.org }\n');
  globalThis.fetch = async () => { throw new Error('the store was asked'); };
  try { await build({ root, log: l => lines.push(l), engine: plain, strict: true, noStore: true }); } finally { globalThis.fetch = real; }
  assert.ok(lines.some(l => /the store was not asked, --no-store/.test(l)));
});
