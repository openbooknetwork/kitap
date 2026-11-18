// Walk content/<story>/, read the pages with their texts, images and catalogues, let the engine read its own files
// and fields, and write dist/: the story bundle, a static page per step and language, the main page and the crawl
// files. The engine is the package that draws the viewport; its hooks are documented in README.md.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import yaml from 'js-yaml';
import { marked } from 'marked';
import { check, Site, storySchema, pageSchema, Group, ImageFolder, Themes } from './schema.mjs';
import { loadCatalogues, translator, flatten, unflatten } from './i18n.mjs';
import { esc, ordinals, PLACE, siteContext, storyFiles, siteFiles } from './pages.mjs';
import { libraryItems, storyFolders, isImage, isBattle, isZone } from './folders.mjs';
import { writeVendor } from './vendor.mjs';
import { hash, listDirs, idOf } from './util.mjs';
import { sha256, imageKeys } from './image.mjs';
import { storyTree, checkStore } from './store.mjs';
import { loadEngine, checkEngine } from './engine.mjs';

// PKG is this package. The content project comes in as the root of each build.
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const REPO = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
const COMMON = fs.readFileSync(path.join(PKG, 'src', 'common.js'), 'utf8').replace('/*__REPO__*/', REPO);
// the story page shell, and the script every story page shares as dist/kitap.js
const APP = fs.readFileSync(path.join(PKG, 'src', 'app.html'), 'utf8');
const APP_JS = COMMON + '\n' + fs.readFileSync(path.join(PKG, 'src', 'app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(PKG, 'src', 'index.html'), 'utf8').replace('/*__COMMON__*/', COMMON);
// a script's version in its URL, so a browser holding the last release's copy fetches the new one
const version = text => hash(text).slice(0, 10);
// the shape of the main page card kept in the cache. A card of another shape counts as no cache.
const CARD_FORMAT = 9;
// Cache files are written whole and renamed into place, so a build running at the same time reads the old file or
// the new one. A file that is missing or does not parse counts as no cache.
const readCache = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
// Copies an original unless dest already holds it, through a temporary file, so a build running beside reads it whole.
const copyFresh = (file, dest) => {
  const from = fs.statSync(file), to = fs.existsSync(dest) && fs.statSync(dest);
  if (to && to.size === from.size && to.mtimeMs >= from.mtimeMs) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}`;
  fs.copyFileSync(file, tmp); fs.renameSync(tmp, dest);
};
const writeCache = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(value)); fs.renameSync(tmp, file); };

// ---------- the live record: each story's inputs as the site bucket holds them ----------
// kitap deploy writes RECORD_KEY to the pages bucket last. build --changed reads it from the site and rebuilds only
// the stories whose inputs differ, so a fresh checkout builds what changed. A build writes BUILT_FILE into dist/
// for deploy: the stories it built, with their fingerprints and cards.
export const RECORD_KEY = 'kitap-build.json', BUILT_FILE = '.kitap-build.json', RECORD_FORMAT = 1;
const KITAP_VERSION = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;
// The files a build reads: content/, i18n/, plugins/ and site.yaml as git shows them, tracked or new and not ignored,
// so a checkout and a working copy agree. Outside git every file counts. Dot folders hold notes and generators.
function inputFiles(root) {
  const roots = ['content', 'i18n', 'plugins', 'site.yaml'];
  let files;
  try { files = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard', '--', ...roots], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0'); }
  catch { files = roots.flatMap(r => !exists(path.join(root, r)) ? [] : fs.statSync(path.join(root, r)).isFile() ? [r] : fs.readdirSync(path.join(root, r), { recursive: true }).map(f => path.join(r, f))); }
  return files.filter(Boolean).map(f => f.split(path.sep).join('/'))
    .filter(f => !f.split('/').some(s => s.startsWith('.')) && fs.statSync(path.join(root, f), { throwIfNoEntry: false })?.isFile()).sort();
}
// What a story's fingerprint reads: the files under a folder, every file's hash once, and the inputs of every story:
// site.yaml, the site catalogues, plugins, the files of content/shared/ outside an item folder, kitap and the engine.
function inputSet(p, engine, engineJs) {
  const files = inputFiles(p.root), sums = new Map();
  const sum = f => { if (!sums.has(f)) sums.set(f, crypto.createHash('sha256').update(fs.readFileSync(path.join(p.root, f))).digest('hex')); return sums.get(f); };
  const under = dir => files.filter(f => f.startsWith(dir.replace(/\/?$/, '/')));
  const items = new Map(), isItem = d => { if (!items.has(d)) items.set(d, isImage(path.join(p.root, d)) || isBattle(path.join(p.root, d)) || isZone(path.join(p.root, d))); return items.get(d); };
  const inItem = f => { const parts = f.split('/'); for (let i = 3; i < parts.length; i++) if (isItem(parts.slice(0, i).join('/'))) return true; return false; };
  const loose = under('content/shared').filter(f => !inItem(f));
  const shared = files.filter(f => !f.startsWith('content/')).concat(loose);
  const enginePkg = engine.dir ? readCache(path.join(engine.dir instanceof URL ? fileURLToPath(engine.dir) : engine.dir, 'package.json'))?.version : null;
  const tools = [RECORD_FORMAT, CARD_FORMAT, KITAP_VERSION, `${engine.id}@${enginePkg ?? ''}`, version(engineJs ?? '')];
  return { fingerprint: (storyDir, folders = []) => hash([...tools, ...[...new Set([...under(storyDir), ...folders.flatMap(under), ...shared])].sort().map(f => `${f} ${sum(f)}`)]) };
}
// the shared folders a built story read, from the folders whose catalogues it carries
const sharedFolders = card => Object.keys(card.folderI18n).map(d => d.split(path.sep).join('/')).filter(d => d.startsWith('content/shared/')).sort();

// The record of the live site, read from site.yaml's url, or null when the site has none, so every story builds.
async function liveRecord(root, get, log) {
  const p = project(root, log), site = readSite(p);
  if (!site.url) fail('site.yaml', 'add url: the address the site is published at, where build --changed reads the record of the live site');
  const at = new URL(RECORD_KEY, site.url.endsWith('/') ? site.url : site.url + '/');
  at.searchParams.set('t', String(Date.now())); // past the site's ten minute cache
  try {
    const res = await get(at.href);
    if (res.status === 404) { log(`${at.origin} has no build record yet, so every story builds`); return null; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const record = await res.json();
    if (record?.format !== RECORD_FORMAT) { log(`the build record of ${at.origin} has another format, so every story builds`); return null; }
    return record;
  } catch (err) { log(`the build record of ${at.origin} did not load (${err.message}), so every story builds`); return null; }
}
const UI_DIR = path.join(PKG, 'src', 'i18n');
const readUi = dir => Object.fromEntries(fs.readdirSync(dir).filter(f => f.endsWith('.yaml')).map(f => [f.replace(/\.yaml$/, ''), yaml.load(fs.readFileSync(path.join(dir, f), 'utf8')) ?? {}]));
const UI = readUi(UI_DIR);
// Icons come from Lucide: the shell's own, and the ones an engine asks for by name
const ICON_DIR = path.dirname(require.resolve('lucide-static/icons/flag.svg'));
const SHELL_ICONS = ['x', 'external-link', 'chevron-left', 'chevron-right', 'list', 'info', 'settings', 'languages', 'message-circle'];
function iconSvg(name, where) {
  const file = path.join(ICON_DIR, name + '.svg');
  if (!exists(file)) fail(where, `unknown icon "${name}", pick a name from https://lucide.dev/icons`);
  return fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/\s*class="[^"]*"/, '').replace(/\s+/g, ' ').replace(/> </g, '><').trim();
}

const fail = (where, msg) => { throw new Error(`${where}: ${msg}`); };
const exists = p => fs.existsSync(p);
const listFiles = (p, ext) => exists(p) ? fs.readdirSync(p).filter(f => f.endsWith(ext)).sort() : [];
const writeFile = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

const emptyText = langs => Object.fromEntries(langs.map(l => [l, '']));
// A when value with the missing parts rounded down for from and up for to.
const whenEdge = (s, isEnd) => { const [y, m, d] = s.split('-'); return `${y}-${m ?? (isEnd ? '12' : '01')}-${d ?? (isEnd ? '31' : '01')}`; };

// --- interface strings: what kitap ships, what the engine ships laid over it, and the project's i18n/ui/<lang>.yaml over both ---
const engineUiCache = new Map();
function engineUi(engine) {
  if (!engine?.ui) return {};
  const dir = engine.ui instanceof URL ? fileURLToPath(engine.ui) : engine.ui;
  if (!engineUiCache.has(dir)) engineUiCache.set(dir, exists(dir) ? readUi(dir) : {});
  return engineUiCache.get(dir);
}
const shipped = (engine, lang) => ({ ...flatten(UI[lang] ?? {}), ...flatten(engineUi(engine)[lang] ?? {}) });
const uiOwn = (root, l) => { const f = path.join(root, 'i18n', 'ui', l + '.yaml'); return exists(f) ? flatten(yaml.load(fs.readFileSync(f, 'utf8')) ?? {}) : {}; };
// Interface keys: every string shipped in English, plus a name for each theme the site offers.
export function uiCatalogue(root, lang, themes, engine = null) {
  const en = shipped(engine, 'en');
  const entries = Object.keys(en).filter(k => !k.startsWith('themes.')).map(key => ({ key, source: en[key], shared: false, inline: null }))
    .concat(Object.entries(themes).map(([id, t]) => ({ key: `themes.${id}`, source: en[`themes.${id}`] ?? (typeof t.name === 'string' ? t.name : t.name?.en) ?? id, shared: false, inline: null })));
  // a theme that still carries an inline name for this language counts as translated
  const inlineNames = Object.fromEntries(Object.entries(themes).filter(([, t]) => typeof t.name === 'object' && t.name?.[lang]).map(([id, t]) => [`themes.${id}`, t.name[lang]]));
  const own = shipped(engine, lang);
  const have = { ...inlineNames, ...own, ...uiOwn(root, lang) };
  return { entries, existing: have, missing: entries.filter(e => !have[e.key] && !Object.keys(have).some(k => k.startsWith(e.key + '.'))).map(e => e.key), shipped: Object.keys(own).length > 0 };
}
// dir is the language's writing direction, from ICU; Node before 23 has textInfo, later ones getTextInfo()
const textDir = l => { const loc = new Intl.Locale(l); return (loc.getTextInfo?.() ?? loc.textInfo).direction; };
// digits is the numbering system of a language whose writing rules ask for digits other than 0-9
const DIGITS = { fa: 'arabext', bn: 'beng' };
function uiFor(langs, root, engine) {
  // a missing key falls back to English alone
  return Object.fromEntries(langs.map(l => [l, { ...unflatten({ ...shipped(engine, 'en'), ...shipped(engine, l), ...uiOwn(root, l) }), dir: textDir(l), digits: DIGITS[l.split('-')[0]] ?? 'latn' }]));
}
// A level's name in each language: the interface string levels.<id>, else the id.
const levelList = (levels, ui, langs) => levels.map(id => ({ id, name: Object.fromEntries(langs.map(l => [l, ui[l].levels?.[id] ?? id])) }));
const themeList = (themes, ui, langs) => Object.entries(themes).map(([id, t]) => ({ id, name: Object.fromEntries(langs.map(l => [l, ui[l].themes?.[id] ?? (typeof t.name === 'string' ? t.name : t.name?.[l] ?? t.name?.en) ?? id])) }));

// A map field written at the top level of story.yaml or page.yaml is sent under the engine's key, so a file from
// before the engines were split reads as one written now.
function lift(data, engine, schema) {
  const shape = schema?.shape ?? schema?.def?.shape ?? null;
  if (!engine || !shape || !data || typeof data !== 'object') return data;
  for (const k of Object.keys(shape)) if (k in data && !(k in (data[engine.id] ?? {}))) { (data[engine.id] ??= {})[k] = data[k]; delete data[k]; }
  return data;
}

// The content project of one build: its folders, its logger, and readers that name files relative to it.
function project(root, log) {
  const rel = p => path.relative(root, p);
  const loadYaml = p => { try { return yaml.load(fs.readFileSync(p, 'utf8')) ?? {}; } catch (e) { fail(rel(p), e.message); } };
  const readYaml = (p, schema) => check(schema, loadYaml(p), rel(p));
  const readJson = (p, schema) => { let data; try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { fail(rel(p), e.message); } return schema ? check(schema, data, rel(p)) : data; };
  // the links of an image's objects, from the site root or absolute. buildPages sets them for its assets mode.
  const imageLinks = ({ keys }) => ({ original: `assets/${keys.original}`, large: `assets/${keys.large}`, small: `assets/${keys.small}` });
  return { root, content: path.join(root, 'content'), dist: path.join(root, 'dist'), log, rel, loadYaml, readYaml, readJson, imageLinks, options: {} };
}
// a link from the site root as a story page uses it, below its story folder
const fromStory = u => /^https?:/.test(u) ? u : `../${u}`;
const IMAGE_FILE = /\.(jpe?g|png|webp|gif|svg)$/i;

const LAND_SLOTS = 8;
// CSS for every theme: tokens on :root[data-palette=id], light and dark; the default theme also on bare :root
function themeCss(themes, defaultId) {
  const TOKEN = { paper: '--paper', paper2: '--paper-2', sea: '--sea', ink: '--ink', ink2: '--ink-2', rule: '--rule', accent: '--accent', panel: '--panel', route: '--route', border: '--border' };
  const lum = hex => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  // eight land slots always, filled up from paper2, so a theme without tints paints one colour and never inherits another theme's
  const land = set => [...Array(LAND_SLOTS)].map((_, i) => `--land-${i}:${set.land?.[i % set.land.length] ?? set.paper2};`).join('');
  const decl = set => Object.entries(set).filter(([k]) => TOKEN[k]).map(([k, v]) => `${TOKEN[k]}:${v};`).join('') + land(set) + (lum(set.paper) < 0.5 ? 'color-scheme:dark;' : 'color-scheme:light;');
  const block = (sel, t) => `${sel}{${decl(t.light)}}@media (prefers-color-scheme: dark){${sel}:not([data-theme="light"]){${decl(t.dark)}}}${sel}[data-theme="dark"]{${decl(t.dark)}}`;
  return block(':root', themes[defaultId]) + Object.entries(themes).map(([id, t]) => block(`:root[data-palette="${id}"]`, t)).join('');
}

// whether a text names a place by its label, or by the label without a part in brackets, at the start of a word, so a
// Turkish suffix such as Gelibolu’ya counts
const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const mentions = (text, label) => [label, label.replace(/\s*\(.*\)$/, '')].some(l => l && NO_SPACES.test(l) ? text.includes(l) : l && new RegExp(`(?<![\\p{L}\\p{N}])${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(text));

// The story's content as text: story.yaml, the page tree with each page's text, the images they show, and what the
// engine read from its own files and fields. onProblem(folder, message, page id) takes each problem, else the first
// throws.
function readContent(p, storyDir, engine, onProblem = null) {
  const { rel, readYaml, readJson, log, root } = p;
  const where = rel(storyDir), shared = path.join(storyDir, 'shared'), storyFile = path.join(storyDir, 'story.yaml');
  const pageIdOf = new Map(); // a page folder's page id, so check can keep to the pages it was given
  const attempt = (dir, fn) => { if (!onProblem) return fn(); try { return fn(); } catch (err) { onProblem(dir, err.message, pageIdOf.get(dir)); } };
  const warnings = [];
  const story = check(storySchema(engine), lift(p.loadYaml(storyFile), engine, engine.schemas.story), rel(storyFile));
  const langs = story.languages;
  const defaultLang = story.default_language ?? langs[0];
  // strings: the default language inline, the others from i18n/<lang>.yaml catalogues
  const { tr: T, entries, report } = translator({ langs, defaultLang, catalogues: loadCatalogues(path.join(storyDir, 'i18n'), langs, p.loadYaml), where: `${where}/i18n`, fail });
  const images = {}, definedIn = {};
  const define = (table, id, value, file, kind, dir) => { if (table[id]) fail(file, `${kind} "${id}" is defined twice`); table[id] = value; definedIn[`${kind} ${id}`] = dir; };
  const icons = {}, icon = (name, at) => icons[name] ??= iconSvg(name, at);
  for (const n of SHELL_ICONS) icon(n, where);
  const texts = {}, firstImages = {};
  // per page id, the page's folder and each language's text as on disk, for kitap i18n --stale and --stamp
  const pageTexts = {};
  // per text file, the names the page's engine items carry that the text writes without a link, for check --places
  const unlinked = [];

  // the items of a library at any depth, by their folder names as written, so a reference finds the same folder on
  // every file system
  const libraries = new Map();
  const library = (dir, isItem, pattern, rule) => {
    if (!libraries.has(dir)) {
      let items;
      try { items = libraryItems(dir, isItem, rel); } catch (err) { fail(rel(dir), err.message); }
      for (const [name, full] of items) if (!pattern.test(name)) fail(rel(full), rule);
      libraries.set(dir, items);
    }
    return libraries.get(dir);
  };
  const imageLib = dir => library(dir, isImage, /^[a-z0-9][a-z0-9-]*-[0-9a-f]{6}$/, 'an image folder is named <name>-<six hex digits>, such as hastings-knights-3f9a1c, and kitap image <file> <name> makes one');
  const storyImages = path.join(shared, 'images'), commonImages = path.join(p.content, 'shared', 'images');

  // --- image folders: <id>/image.yaml, and the original where this machine has it, read when a text, marker or card
  // first names one. Its objects are in the asset store, or with --local-assets the original is copied to dist/assets/.
  const folderImages = {};
  const loadImageFolder = (dir, id) => {
    if (folderImages[id]) return id;
    const meta = path.join(dir, 'image.yaml'), files = fs.readdirSync(dir).filter(f => /^image\.\w+$/.test(f) && f !== 'image.yaml');
    if (!exists(meta)) fail(rel(dir), 'image.yaml is missing');
    if (files.length > 1) fail(rel(dir), `keep one image file of ${files.join(', ')}`);
    const m = readYaml(meta, ImageFolder);
    if (files.length && files[0] !== m.file) fail(rel(meta), `file names ${m.file} and the folder holds ${files[0]}, kitap rehash writes the file it holds`);
    const t = translator({ langs, defaultLang: m.default_language, catalogues: loadCatalogues(path.join(dir, 'i18n'), langs, p.loadYaml), where: rel(meta), fail });
    const keys = imageKeys(id, m), file = files.length ? path.join(dir, files[0]) : null;
    const links = p.imageLinks({ keys, file, url: m.url ?? null, at: rel(dir) });
    define(images, id, { id, src: fromStory(links.large), thumb: fromStory(links.small), caption: t.tr(m.caption, 'image.caption'), credit: m.credit ? t.tr(m.credit, 'image.credit', { shared: true }) : emptyText(langs) }, rel(meta), 'image', dir);
    // social sites read no SVG, so og:image takes the 1280 px WebP of one
    const og = path.extname(m.file) === '.svg' ? links.large : links.original;
    folderImages[id] = { id, dir: rel(dir), meta: rel(meta), file, url: m.url ?? null, sha256: m.sha256, keys, links: { ...links, og }, defaultLang: m.default_language, translator: t };
    return id;
  };
  // an image a text, an engine item or a card names: the image folder the scope sees by that id
  const resolveImage = (s, ref, at) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(ref)) fail(at, `unknown image "${ref}", an image id is lowercase letters, digits and dashes`);
    const dirs = s.imageDirs.map(d => imageLib(d).get(ref)).filter(Boolean);
    if (dirs.length > 1) fail(at, `image "${ref}" is in ${dirs.map(rel).join(' and ')}, keep one`);
    if (dirs.length) return loadImageFolder(dirs[0], ref);
    fail(at, `unknown image "${ref}"`);
  };

  // A scope is the story's files or an included item's, such as a battle's. It carries the translator of its
  // catalogues, the image libraries it sees, how its ids and page ids read in the story, and where its texts go.
  // textFallback lets a page without a text in a language show the scope's default language text.
  const scope = (fields) => ({ kind: 'story', T, defaultLang, imageDirs: [storyImages, commonImages], ns: id => id, pageId: id => id, texts, firstImages, fallbacks: {}, textFallback: true, prepare: null, decorate: null, include: null, ...fields });
  const storyScope = scope({});
  // what the engine's hooks see
  const ctx = { root, content: p.content, rel, where, storyFile: rel(storyFile), story, langs, defaultLang, T, fail, attempt, warn: m => warnings.push(m), log, readYaml, readJson, loadYaml: p.loadYaml,
    library, icon, resolveImage, define, images, idOf, listFiles, exists, strict: !!p.strict, onProblem, scope, storyScope, emptyText: () => emptyText(langs), storyImages, commonImages, options: p.options, texts, firstImages,
    // a translator over a folder's own catalogues, for an item of the engine's that carries its strings in its folder
    translatorFor: ({ defaultLang: d, dir, where: w }) => translator({ langs, defaultLang: d, catalogues: loadCatalogues(path.join(dir, 'i18n'), langs, p.loadYaml), where: w, fail }) };
  const E = engine.read.story(story, ctx);
  ctx.state = E; storyScope.engine = E;

  // --- pages/ is a tree: a folder with page.yaml is a page, one with include.yaml places another item's pages, any
  // other folder is a header for what it holds ---
  const walk = (dir, s) => listDirs(dir).map(name => {
    const full = path.join(dir, name), id = idOf(name);
    if (exists(path.join(full, 'page.yaml')) && exists(path.join(full, 'include.yaml'))) return attempt(full, () => fail(rel(full), 'holds page.yaml and include.yaml, keep one: a folder is a page or the place of an include'));
    if (exists(path.join(full, 'page.yaml'))) { pageIdOf.set(full, s.pageId(id)); return { type: 'page', id: s.pageId(id), dir: full, scope: s }; }
    if (exists(path.join(full, 'include.yaml'))) return attempt(full, () => engine.read.include ? engine.read.include(full, s, ctx) : fail(rel(path.join(full, 'include.yaml')), `the ${engine.id} engine includes nothing, a folder holds page.yaml or group.yaml`));
    const g = exists(path.join(full, 'group.yaml')) ? attempt(full, () => readYaml(path.join(full, 'group.yaml'), Group)) ?? {} : {};
    return { type: 'group', id, title: s.T(g.title ?? id, `groups.${id}.title`), children: walk(full, s) };
  }).filter(Boolean);
  const pagesIn = nodes => nodes.flatMap(n => n.type === 'page' ? [n] : pagesIn(n.children));
  ctx.walk = walk; ctx.pagesIn = pagesIn;

  // --- pages ---
  const figure = (id, lang) => {
    const im = images[id];
    return `<figure><img src="${esc(im.src)}" alt="${esc(im.caption[lang])}" data-img="${esc(id)}"><figcaption>${esc(im.caption[lang])}<small dir="auto">${esc(im.credit[lang])}</small></figcaption></figure>`;
  };
  // per page and language: the Markdown source, and the first image the text shows, for the static pages
  function readPage(dir, s) {
    const file = path.join(dir, 'page.yaml'), at = rel(file), own = idOf(path.basename(dir)), pid = s.pageId(own);
    const pg = check(pageSchema(engine), lift(p.loadYaml(file), engine, engine.schemas.page), at);
    const texts = s.texts[pid] = {}, firstImages = s.firstImages[pid] = {};
    const pageText = pageTexts[pid] = { dir: rel(dir), texts: {} };
    const need = (ok, msg) => attempt(dir, () => ok || fail(at, msg));
    const w = pg.when == null ? null : typeof pg.when === 'string' ? { from: pg.when } : pg.when;
    const when = w && { from: whenEdge(w.from, false), to: whenEdge(w.to ?? w.from, true) };
    if (when) need(when.to >= when.from, 'when.to is before when.from');
    // the engine's fields of the page, and how the text's links resolve
    const ep = attempt(dir, () => engine.read.page(pg[engine.id] ?? {}, { dir, at, own, pid, scope: s, core: pg }, ctx)) ?? { data: {} };
    const links = ep.links ?? null;
    const textOf = lang => { const f = path.join(dir, 'text', lang + '.md'); return exists(f) ? [f, fs.readFileSync(f, 'utf8')] : null; };
    const html = {};
    for (const lang of langs) attempt(dir, () => {
      // an included page without a text in this language shows its default language text
      let found = textOf(lang), fallback = false;
      if (!found && s.textFallback && lang !== s.defaultLang) {
        found = textOf(s.defaultLang);
        if (!found) fail(rel(dir), `text/${s.defaultLang}.md is missing`);
        fallback = true; (s.fallbacks[lang] ??= []).push(pid);
      }
      if (!found) fail(rel(dir), `text/${lang}.md is missing`);
      const [textFile, source] = found;
      if (!fallback) pageText.texts[lang] = source;
      // the image ids become the bundle's, so the Markdown export and og:image find an included item's images
      texts[lang] = source.replace(/^(@image\s+)(\S+)(\s*)$/gm, (_, head, imgId, tail) => {
        const id = resolveImage(s, imgId, rel(textFile));
        firstImages[lang] ??= id;
        return head + id + tail;
      });
      const md = texts[lang].replace(/^@image\s+(\S+)\s*$/gm, (_, imgId) => `\n${figure(imgId, lang)}\n`)
        .replace(PLACE, (_, name, id) => {
          if (!links) attempt(dir, () => fail(rel(textFile), `[${name}](@${id}) links to "${id}", and this page has nothing to link`));
          else if (!links.has(id)) attempt(dir, () => fail(rel(textFile), links.missing(name, id)));
          return `<span class="place"${links?.attr(id) ?? ` data-ref="${esc(id)}"`} tabindex="0">${name}</span>`;
        });
      if (!fallback && links?.names) {
        const linked = new Set([...source.matchAll(PLACE)].map(m => m[2])), prose = source.replace(PLACE, ' ');
        const names = links.names(lang).filter(([id]) => !linked.has(id)).filter(([, label]) => label && mentions(prose, label));
        if (names.length) unlinked.push({ pageId: pid, file: rel(textFile), names: names.map(([id, label]) => `${label} (@${id})`) });
      }
      const out = marked.parse(ordinals(md));
      html[lang] = fallback ? `<div lang="${s.defaultLang}" dir="${textDir(s.defaultLang)}">${out}</div>` : out;
    });
    const sourceTexts = pg.sources.map((x, i) => s.T(x, `pages.${own}.sources.${i}`, { shared: true }));
    const sources = Object.fromEntries(langs.map(l => [l, sourceTexts.map(x => x[l])]));
    // credits the engine's page data carries beyond the story's, behind an "Other sources" button in the viewport
    const creditTexts = (ep.credits ?? []).map((x, i) => s.T(x.text, `pages.${own}.${ep.creditsKey ?? 'credits'}.${i}`, { shared: true }));
    const credits = Object.fromEntries(langs.map(l => [l, (ep.credits ?? []).map((x, i) => ({ text: creditTexts[i][l], url: x.url ?? null }))]));
    return { id: pid, dir: rel(dir), include: s.include, when, date: pg.date != null ? s.T(pg.date, `pages.${own}.date`) : emptyText(langs), title: s.T(pg.title, `pages.${own}.title`),
      html, sources, credits, card: pg.card ?? null, [engine.id]: ep.data ?? {} };
  }
  ctx.readPage = readPage;

  // the story's pages and the pages of what it includes, in reading order
  const tree = walk(path.join(storyDir, 'pages'), storyScope), nodes = pagesIn(tree);
  if (!nodes.length) fail(where, 'no pages');
  const storyDirs = [shared, ...nodes.filter(n => n.scope === storyScope).map(n => n.dir)];
  for (const dir of storyDirs) attempt(dir, () => engine.read.folder(dir, storyScope, ctx));
  if (engine.read.prepare) attempt(storyDir, () => engine.read.prepare(ctx)); // the engine's cross references, once every file is read
  const pages = nodes.map(n => {
    n.scope.prepare?.();
    const pg = attempt(n.dir, () => readPage(n.dir, n.scope));
    return pg && (n.scope.decorate?.(pg) ?? pg);
  }).filter(Boolean);
  const coverImage = story.cover ? attempt(storyDir, () => resolveImage(storyScope, story.cover, `${rel(storyFile)} cover`)) ?? null : null;
  // a second cover for a dark screen stands beside the first, which link previews and light screens show
  if (story.cover_dark && !story.cover) attempt(storyDir, () => fail(rel(storyFile), 'cover_dark is the cover on a dark screen, add cover for every other screen'));
  const coverDarkImage = story.cover_dark ? attempt(storyDir, () => resolveImage(storyScope, story.cover_dark, `${rel(storyFile)} cover_dark`)) ?? null : null;
  // the engine's checks over the whole story, the images its items show, and the folders it read catalogues from
  const fin = attempt(storyDir, () => engine.read.finish({ story, pages, texts, images, coverImage }, ctx)) ?? {};
  // a page without a text in a language showed its default language text
  for (const [lang, ids] of Object.entries(storyScope.fallbacks)) warnings.push(`no ${lang} text on ${ids.join(', ')}, they show the ${defaultLang} text`);
  for (const f of fin.folders ?? []) for (const [lang, ids] of Object.entries(f.fallbacks ?? {})) warnings.push(`${f.kind} "${f.id}" has no ${lang} text on ${ids.join(', ')}, they show the ${f.defaultLang} text`);
  // the bundle and dist/ hold what the pages show: the images of their texts, and the ones the engine's items show
  const shownImages = new Set([...pages.flatMap(pg => langs.flatMap(l => [...(texts[pg.id]?.[l] ?? '').matchAll(/^@image\s+(\S+)\s*$/gm)].map(m => m[1]))),
    ...(fin.images ?? []), ...(coverImage ? [coverImage] : []), ...(coverDarkImage ? [coverDarkImage] : [])]);
  for (const id of Object.keys(images)) if (!shownImages.has(id)) delete images[id];
  // --strict holds each original on this machine to the sha256 its image.yaml records, which names its objects
  const shipped = Object.values(folderImages).filter(f => shownImages.has(f.id));
  if (p.strict) for (const f of shipped) if (f.file && f.sha256 !== sha256(f.file)) fail(f.meta, `${path.basename(f.file)} changed after its sha256 was written, kitap rehash writes the new one`);
  for (let i = 1; i < pages.length; i++) attempt(path.join(root, pages[i].dir), () => {
    if (pages.find((q, j) => j < i && q.id === pages[i].id)) fail(where, `two pages share the id "${pages[i].id}"`);
    const prev = pages.slice(0, i).reverse().find(q => q.when);
    if (!prev || !pages[i].when || pages[i].when.from >= prev.when.from) return;
    // an included item moves by its include folder, since the numbers in its own folder count in every story
    const moved = pages[i].include !== prev.include ? pages[i].include ?? prev.include : null;
    fail(where, `${pages[i].dir} starts ${pages[i].when.from}, before ${prev.dir} which starts ${prev.when.from}; ${moved ? `renumber ${moved} to move it` : 'fix the folder numbers or the when fields'}`);
  });
  return { story, langs, defaultLang, T, entries, translations: report, tree, images, icons, pages, texts, firstImages, warnings: [...warnings, ...(fin.warnings ?? [])], unlinked, fallbacks: storyScope.fallbacks,
    imageFolders: Object.values(folderImages), shippedImages: shipped, coverImage, coverDarkImage, engine: E, folders: fin.folders ?? [], state: E, pageTexts };
}

// The objects a story links to: its images with their keys and where their originals are, the engine's objects in
// their groups, and the hash tree of both, under the story's folder name.
function storyObjects(name, content, engine, ctx) {
  const images = content.shippedImages.map(f => ({ id: f.id, dir: f.dir.split(path.sep).join('/'), keys: f.keys, file: f.file, url: f.url, sha256: f.sha256 }));
  const own = engine.objects(content, ctx) ?? {};
  const groups = own.groups ?? {};
  return { images, groups, own, tree: storyTree(name, images, groups) };
}

function buildStory(p, storyDir, site, engine) {
  const { log, root } = p;
  const where = p.rel(storyDir);
  const content = readContent(p, storyDir, engine);
  const { story, langs, defaultLang, T, entries, translations, tree, images, icons, pages, texts, firstImages, warnings, imageFolders, shippedImages, coverImage, coverDarkImage, folders, fallbacks, pageTexts } = content;
  for (const w of warnings) log(`  warning: ${w}`);
  const ui = uiFor(langs, root, engine);
  const { tr: siteT } = translator({ langs, defaultLang: site.default_language ?? defaultLang, catalogues: loadCatalogues(path.join(root, 'i18n'), langs, p.loadYaml), where: 'i18n', fail });
  if (story.theme && !site.themes[story.theme]) fail(where, `unknown theme "${story.theme}"`);
  // the story is written to a fresh folder and swapped in once it built, so a failed build keeps the last good one
  // and a page that went leaves no file behind
  const final = path.join(p.dist, story.id), out = path.join(p.dist, `.${story.id}.next`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  // with --local-assets each original here is copied to dist/assets/<key>, once for every story that shows it
  const localKeys = [];
  if (p.local) for (const f of shippedImages.filter(f => f.file)) {
    copyFresh(f.file, path.join(p.dist, 'assets', f.keys.original));
    localKeys.push(f.keys.original);
  }
  const ectx = { root, where, log, fail, cache: p.cache, strict: !!p.strict, local: !!p.local, hash, readCache, writeCache, rel: p.rel, langs, defaultLang, T, objectLink: p.objectLink, options: p.options, site };
  const objects = storyObjects(path.basename(storyDir), content, engine, ectx);

  // --- the engine's bundle: what the viewport receives, the families it colours by and the credits it shows ---
  const eb = engine.bundle(content, { ...ectx, objects }) ?? {};
  for (const w of eb.warnings ?? []) log(`  warning: ${w}`);
  const families = eb.families ?? {};
  const pageIndex = Object.fromEntries(pages.map((p, i) => [p.id, i]));
  const navTree = nodes => nodes.map(n => n.type === 'page' ? { type: 'page', index: pageIndex[n.id] } : { type: 'group', id: n.id, title: n.title, children: navTree(n.children) });

  // --- the cover on the site index, an image the story can show ---
  const cover = coverImage ? images[coverImage].src : null;
  const coverLinks = coverImage ? shippedImages.find(f => f.id === coverImage).links : null;
  const coverDark = coverDarkImage ? images[coverDarkImage].src : null;
  const coverDarkLinks = coverDarkImage ? shippedImages.find(f => f.id === coverDarkImage).links : null;
  // the paths harita 0.4 served each image at, from the site root, to its original: dist/redirects.json
  const redirects = {};
  for (const f of shippedImages) {
    const ext = path.extname(f.keys.original), to = /^[a-z]+:/i.test(f.links.original) ? f.links.original : '/' + f.links.original;
    redirects[`/images/${f.id}${ext}`] = to; redirects[`/${story.id}/images/${f.id}${ext}`] = to;
  }

  // span is story.span, else the years from the pages' when fields, else the first page's date
  const dated = pages.filter(p => p.when);
  const years = dated.length ? [...new Set([dated[0].when.from.slice(0, 4), dated[dated.length - 1].when.to.slice(0, 4)])].join(' – ') : null;
  const span = story.span ? T(story.span, 'story.span') : Object.fromEntries(langs.map(l => [l, years ?? pages[0].date[l]]));
  const summary = story.summary ? T(story.summary, 'story.summary') : {};

  // --- bundle and pages ---
  const bundle = {
    id: story.id, title: T(story.title, 'story.title'), summary, span, cover, coverDark, languages: langs, defaultLanguage: defaultLang, ui, families, engine: engine.id,
    site: { title: siteT(site.title, 'site.title'), languages: site.langs, defaultLanguage: site.defaultLang, ask: site.ask ?? [], credit: site.credit !== false,
      source: site.repository ? `${site.repository.replace(/\/$/, '')}/tree/${site.branch}/${where.split(path.sep).join('/')}` : null },
    themes: themeList(site.themes, ui, langs), defaultTheme: story.theme ?? site.theme,
    credits: eb.credits ?? [], images, icons, pages: pages.map(({ dir, include, ...p }) => p), tree: navTree(tree),
    [engine.id]: eb.data ?? {},
  };
  const familyCss = Object.entries(families).map(([f, c]) => `--z-${f}:${c.color};`).join('');
  const familyCssDark = Object.entries(families).map(([f, c]) => `--z-${f}:${c.color_dark ?? c.color};`).join('');
  const shell = site.shell.replace('/*__FAMILY_CSS__*/', () => familyCss).replaceAll('/*__FAMILY_CSS_DARK__*/', () => familyCssDark)
    .replace('/*__THEMES_CSS__*/', () => themeCss(site.themes, bundle.defaultTheme));
  const storyJs = `const BUNDLE = ${JSON.stringify(bundle)};\n`;
  writeFile(path.join(out, 'story.js'), storyJs);
  const links = Object.fromEntries(shippedImages.map(f => [f.id, f.links]));
  const files = storyFiles({ shell, bundle, texts, firstImages, links, coverImage, site: site.context, engine: engine.id, versions: { story: version(storyJs), app: version(APP_JS), engine: site.engineVersion } });
  for (const [f, text] of Object.entries(files)) writeFile(path.join(out, f), text);
  log(`  wrote dist/${story.id}/ (story.js ${(Buffer.byteLength(storyJs) / 1e6).toFixed(1)} MB, ${pages.length} pages in ${langs.join('/')})`);

  // translation coverage per catalogue and language, and with --strict a gap stops the build
  const covered = (label, lang, total, missing, at, extra = '') => {
    log(`  ${label}${lang}: ${total - missing.length} of ${total} strings translated${missing.length ? `, ${missing.length} missing (kitap i18n ${lang})` : ''}${extra}`);
    if (p.strict && missing.length) fail(at, `${lang}: ${missing.length} strings missing, first: ${missing.slice(0, 8).join(', ')}`);
  };
  for (const [lang, r] of Object.entries(translations())) {
    const noText = fallbacks[lang] ?? [];
    covered('', lang, r.total, r.missing, where, noText.length ? `, ${noText.length} pages without text/${lang}.md` : '');
    if (p.strict && noText.length) fail(where, `${lang}: no text/${lang}.md on ${noText.join(', ')}`);
  }
  // an included item's own pages count their texts: a page without a text in the language is a gap too
  for (const f of folders.filter(f => f.pages)) for (const [lang, r] of Object.entries(f.translator.report())) {
    const noText = f.fallbacks?.[lang] ?? [];
    covered(`${f.kind} ${f.id} `, lang, r.total, r.missing, f.dir, noText.length ? `, ${noText.length} pages without text/${lang}.md` : '');
    if (p.strict && noText.length) fail(f.dir, `${lang}: no text/${lang}.md on ${noText.join(', ')}`);
  }
  // the image folders the story ships and the engine's folders whose names it shows count together, one line per kind
  const kinds = [['image folders ', shippedImages], ...Object.entries(Object.groupBy(folders.filter(f => !f.pages && f.used !== false), f => f.kind)).map(([k, fs]) => [`${k} folders `, fs])];
  for (const [label, items] of kinds) for (const lang of langs) {
    const reports = items.map(f => [f, f.translator.report()[lang]]).filter(([, r]) => r);
    if (reports.length) covered(label, lang, reports.reduce((n, [, r]) => n + r.total, 0), reports.flatMap(([f, r]) => r.missing.map(k => `${f.id} ${k}`)), where);
  }
  for (const lang of langs.filter(l => l !== 'en')) {
    const u = uiCatalogue(root, lang, site.themes, engine);
    if (u.missing.length) log(`  ${lang} interface: ${u.entries.length - u.missing.length} of ${u.entries.length} strings translated, ${u.missing.length} missing (kitap i18n ${lang})`);
    if (p.strict && u.missing.length) fail(where, `${lang} interface: ${u.missing.length} strings missing, first: ${u.missing.slice(0, 8).join(', ')}`);
  }
  fs.rmSync(final, { recursive: true, force: true });
  fs.renameSync(out, final);
  // kitap i18n writes the catalogues of each image folder and each folder of the engine's in that folder
  const folderI18n = Object.fromEntries([...folders.map(f => [f.dir, f]), ...imageFolders.map(f => [f.dir, { kind: 'image', ...f }])]
    .map(([dir, f]) => [dir, { kind: f.kind, id: f.id, defaultLang: f.defaultLang, langs, entries: [...f.translator.entries.values()] }]));
  return { format: CARD_FORMAT, id: story.id, dir: where, level: story.level ?? null, follows: story.follows ?? null, title: bundle.title, summary, span, languages: langs, defaultLanguage: defaultLang, pages: pages.length,
    cover: coverLinks?.large ?? null, coverDark: coverDarkLinks?.large ?? null, coverOg: coverLinks?.og ?? null, i18n: [...entries.values()], objects, folderI18n, pageTexts, localKeys, redirects, tree: objects.tree };
}

// The names of the story folders below content/, in groups too, with each one's folder in p.storyDirs. content/shared/
// holds the images and the engine's items stories share.
// The stories a build makes: every story but the drafts. A draft that the command names is built, for a look at it.
function published(p, stories, named = []) {
  const draft = s => { try { return p.loadYaml(path.join(p.storyDirs.get(s), 'story.yaml'))?.draft === true; } catch { return false; } };
  const drafts = stories.filter(s => !named.includes(s) && draft(s));
  if (drafts.length) p.log(`left out ${drafts.length === 1 ? 'the draft' : 'the drafts'} ${drafts.join(', ')}`);
  return stories.filter(s => !drafts.includes(s));
}
function storyNames(p) {
  if (exists(path.join(p.content, 'shared', 'story.yaml'))) fail('content/shared/story.yaml', 'content/shared/ holds what the stories share, move this story to a folder of another name');
  try { p.storyDirs = storyFolders(p.content, p.rel); } catch (err) { fail('content/', err.message); }
  // a story's folder in dist/ sits beside the ones kitap writes
  for (const id of ['assets', 'vendor']) if (p.storyDirs.has(id)) fail(p.rel(p.storyDirs.get(id)), `kitap writes dist/${id}/, give the story another folder name`);
  return [...p.storyDirs.keys()];
}

// The site index. site.yaml is optional: the folder name, alphabetical order and the cool theme stand in.
function buildIndex(p, cards, site, engine) {
  const langs = site.langs, defaultLang = site.defaultLang;
  const order = site.stories ?? cards.map(c => c.id);
  for (const id of order) if (!cards.find(c => c.id === id)) fail('site.yaml', `unknown story "${id}"`);
  const { tr: T, entries, report } = translator({ langs, defaultLang, catalogues: loadCatalogues(path.join(p.root, 'i18n'), langs, p.loadYaml), where: 'i18n', fail });
  const ui = uiFor(langs, p.root, engine);
  // a site that lists levels gives every story one of them, and a site that lists none has stories without one
  for (const c of cards) {
    const at = `content/${c.dir}/story.yaml`;
    if (site.levels && !c.level) fail(at, `level is missing, site.yaml lists the levels ${site.levels.join(', ')}`);
    if (site.levels && c.level && !site.levels.includes(c.level)) fail(at, `level is "${c.level}", site.yaml lists the levels ${site.levels.join(', ')}`);
    if (!site.levels && c.level) fail(at, `level is "${c.level}", and site.yaml lists no levels: add levels: [${c.level}] to site.yaml`);
  }
  const data = {
    title: T(site.title, 'site.title'), intro: site.intro ? T(site.intro, 'site.intro') : {},
    languages: langs, defaultLanguage: defaultLang, ui, repository: site.repository ?? null, credit: site.credit !== false, icons: { settings: iconSvg('settings', 'site.yaml'), languages: iconSvg('languages', 'site.yaml') },
    stories: order.map(id => { const { dir, i18n, objects, folderI18n, pageTexts, localKeys, redirects, tree, coverOg, ...card } = cards.find(c => c.id === id); return card; }),
    themes: themeList(site.themes, ui, langs), defaultTheme: site.theme, levels: site.levels ? levelList(site.levels, ui, langs) : null,
  };
  for (const [lang, r] of Object.entries(report())) {
    if (r.missing.length) p.log(`site ${lang}: ${r.missing.length} of ${r.total} strings missing (kitap i18n ${lang})`);
    if (p.strict && r.missing.length) fail('site.yaml', `${lang}: missing ${r.missing.join(', ')}`);
  }
  p.siteEntries = [...entries.values()];
  // follows.js beside kitap.js names, for each story of a chain, the story before it and the story after it. A
  // story page loads it, so a story's link to the next one needs no rebuild of the story.
  const link = c => c ? { id: c.id, title: c.title, languages: c.languages, defaultLanguage: c.defaultLanguage } : null;
  const chain = Object.fromEntries(cards.map(c => [c.id, { previous: link(cards.find(x => x.id === c.follows)), next: link(cards.find(x => x.follows === c.id)) }]).filter(([, v]) => v.previous || v.next));
  writeFile(path.join(p.dist, 'follows.js'), `window.KITAP_FOLLOWS = ${JSON.stringify(chain)};\n`);
  const css = themeCss(site.themes, site.theme);
  // the 404 page speaks every language a site or story page does
  const notFoundUi = uiFor([...new Set([...langs, ...cards.flatMap(c => c.languages)])], p.root, engine);
  const image = order.map(id => cards.find(c => c.id === id).coverOg).find(Boolean) ?? null;
  const files = siteFiles({ shell: INDEX.replace('/*__THEMES_CSS__*/', () => css), data, image, site: site.context, common: COMMON, themeCss: css, ui: notFoundUi });
  for (const [f, text] of Object.entries(files)) writeFile(path.join(p.dist, f), text);
  p.log(`wrote dist/index.html (${data.stories.length} stories)`);
}

// The engine of a build: the one handed in, else the one site.yaml names, resolved from the project.
function engineOf(p, site, engine) {
  if (engine) return checkEngine(engine, 'engine');
  if (!site.engine) fail('site.yaml', 'add engine: <id>, the package that draws the pages, such as engine: harita');
  return loadEngine(p.root, site.engine);
}

// A story's content as the build reads it, for an engine's own commands. Returns the content with the engine's state.
export function readStory({ root = process.cwd(), story, engine = null, log = () => {} } = {}) {
  const p = project(root, log), stories = storyNames(p);
  if (!stories.includes(story)) fail('content/', `"${story}" is not a story folder, the stories are ${stories.join(', ')}`);
  const e = engineOf(p, readSite(p), engine);
  return readContent(p, p.storyDirs.get(story), e);
}

// The book's own checks: each plugins/checks/<name>.mjs exports a function as its default, which kitap check calls
// with { root, story, dir, pages: [{ id, dir, checked }], rel, loadYaml, note } and which returns its problems as lines.
// note(line) prints a line for a person to weigh, which is no problem and leaves the check ok. They run in the order of their names.
function bookChecks(root) {
  const dir = path.join(root, 'plugins', 'checks');
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.mjs')).sort().map(f => {
    const run = require(path.join(dir, f)).default;
    if (typeof run !== 'function') fail(`plugins/checks/${f}`, 'a check exports a function as its default, which takes the story and returns its problems');
    return [f.slice(0, -4), run];
  });
}

// Every problem in one story's content: the pages, their texts and the files they use, the engine's included. pages
// limits the check to those page ids and to the files outside any page. The checks of plugins/checks/ run after
// kitap's own. Returns the problems, [] when there are none.
// places lists, per text file, the names the page's items carry that the text writes without a link
export function checkStory({ root = process.cwd(), story, pages = [], places = false, log = console.log, engine = null } = {}) {
  const p = project(root, log);
  const stories = storyNames(p);
  if (!stories.includes(story)) fail('content/', `"${story}" is not a story folder, the stories are ${stories.join(', ')}`);
  const storyDir = p.storyDirs.get(story);
  // a problem outside any page, in shared/ or an included item's own files, is always in scope
  const inScope = pageId => !pages.length || pageId == null || pages.includes(pageId);
  const problems = [];
  try {
    const e = engineOf(p, readSite(p), engine);
    const { tree, unlinked, fallbacks } = readContent(p, storyDir, e, (dir, msg, pageId) => { if (inScope(pageId)) problems.push(msg); });
    for (const [lang, ids] of Object.entries(fallbacks)) { const n = ids.filter(inScope).length; if (n) log(`${lang}: ${n} pages without text/${lang}.md show the default language text`); }
    if (places) for (const u of unlinked) if (inScope(u.pageId)) log(`${u.file}: ${u.names.join(', ')}`);
    const dirs = new Map(), collect = nodes => { for (const n of nodes) n.type === 'page' ? dirs.set(n.id, n.dir) : collect(n.children); };
    collect(tree);
    for (const id of pages) if (!dirs.has(id)) problems.push(`${p.rel(storyDir)}/pages: no page "${id}"`);
    // checked marks the pages the command names, every page when it names none
    const list = [...dirs].map(([id, dir]) => ({ id, dir, checked: inScope(id) }));
    for (const [name, run] of bookChecks(root)) problems.push(...(run({ root, story, dir: storyDir, pages: list, rel: p.rel, loadYaml: p.loadYaml, note: m => log(`${name}: note: ${m}`) }) ?? []).map(m => `${name}: ${m}`));
  } catch (err) { problems.push(err.message); } // story.yaml itself or an empty pages/ stops the reading
  return problems;
}

// The image files git tracks under content/, which belong in the asset store. A folder outside git has none.
function trackedImages(root) {
  try { return execFileSync('git', ['ls-files', '-z', '--', 'content'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(f => IMAGE_FILE.test(f)); }
  catch { return []; }
}

// site.yaml with the built-in themes and the defaults that stand in for what it leaves out
function readSite(p) {
  const siteFile = path.join(p.root, 'site.yaml');
  const siteMeta = exists(siteFile) ? p.readYaml(siteFile, Site) : {};
  const builtIn = check(Themes, p.loadYaml(path.join(PKG, 'src', 'themes.yaml')), 'src/themes.yaml');
  return { ...siteMeta, title: siteMeta.title ?? path.basename(p.root), theme: siteMeta.theme ?? 'cool', themes: { ...builtIn, ...(siteMeta.themes ?? {}) } };
}

// The objects each story links to and its hash tree, read as the build reads the stories, with the store of
// site.yaml. story limits it to that story folder. kitap upload puts these objects in the store.
export function storyAssets({ root = process.cwd(), story = null, log = console.log, engine = null, cache = path.join(root, '.cache', 'kitap') } = {}) {
  const p = project(root, log), every = storyNames(p);
  if (!every.length) fail('content/', 'no story.yaml found, run this from a content project');
  if (story && !every.includes(story)) fail('content/', `"${story}" is not a story folder, the stories are ${every.join(', ')}`);
  const stories = published(p, every, story ? [story] : []);
  const site = readSite(p), e = engineOf(p, site, engine);
  if (!site.assets) fail('site.yaml', 'add an assets block with the url, bucket and endpoint of the store for the images and the objects the pages show');
  p.cache = cache;
  const ectx = { root, log, fail, cache, hash, readCache, writeCache, rel: p.rel, options: p.options };
  return { assets: site.assets, engine: e, stories: (story ? [story] : stories).map(s => ({ story: s, ...storyObjects(s, readContent(p, p.storyDirs.get(s), e), e, { ...ectx, where: s }) })) };
}

// The client script of the engine, written beside kitap.js as dist/<engine>.js: its script file, else nothing
function engineScript(engine) {
  const c = engine.client ?? {};
  if (!c.script) return '';
  const file = c.script instanceof URL ? fileURLToPath(c.script) : c.script;
  return fs.readFileSync(file, 'utf8');
}

// Every story under root/content into root/dist, without the engine's objects. kitap i18n reads its strings.
// only names story folders to build; the others keep their last build, and their main page cards come from the cache.
// story builds that one story folder into a site of its own, its main page listing it alone. out replaces dist/.
// changed builds the stories whose fingerprints differ from live, the record of the live site, and the main page
// takes the others' cards from it. A build of every story or of the changed ones writes dist/.kitap-build.json.
// Pages link the images and objects in the store of site.yaml's assets, or with localAssets copies in dist/assets/.
export function buildPages({ root = process.cwd(), log = console.log, strict = false, cache = path.join(root, '.cache', 'kitap'), only = null, story = null, out = null, localAssets = false, engine = null, changed = false, live = null, ...options } = {}) {
  const p = project(root, log);
  p.strict = strict; p.cache = cache; p.local = localAssets; p.options = options;
  if (out) p.dist = path.resolve(root, out);
  if (changed && (only || story)) fail('build', 'build --changed picks the stories itself, leave out --only and --story');
  if (changed && localAssets) fail('build', 'build --changed builds what the live site lacks, whose pages link the asset store: leave out --local-assets');
  const every = storyNames(p);
  if (!every.length) fail('content/', 'no story.yaml found, run this from a content project');
  for (const s of [...(only ?? []), ...(story ? [story] : [])]) if (!every.includes(s)) fail('content/', `"${s}" is not a story folder, the stories are ${every.join(', ')}`);
  const stories = published(p, every, [...(only ?? []), ...(story ? [story] : [])]);
  if (strict) {
    const tracked = trackedImages(root);
    if (tracked.length) fail('content/', `git tracks ${tracked.length} image file${tracked.length === 1 ? '' : 's'}, which belong in the asset store: ${tracked.slice(0, 5).join(', ')}${tracked.length > 5 ? ', …' : ''}. Add the .gitignore lines for image files and git rm --cached them`);
  }
  const cardFile = s => path.join(cache, 'stories', s, 'card.json');
  // a card from the last build of the same assets mode, while that build's page is still in dist/
  const lastCard = s => { const c = readCache(cardFile(s)); return c?.format === CARD_FORMAT && c.local === localAssets && exists(path.join(p.dist, c.id, 'index.html')) ? c : null; };
  const site = readSite(p);
  if (!site.themes[site.theme]) fail('site.yaml', `unknown theme "${site.theme}"`);
  const e = engineOf(p, site, engine);
  const engineJs = engineScript(e);
  site.engineVersion = version(engineJs);
  // a story whose fingerprint matches the live record keeps its pages online, and its card comes from the record
  const recording = !only && !story, inputs = recording ? inputSet(p, e, engineJs) : null, liveStories = live?.stories ?? {};
  const dirOf = s => p.rel(p.storyDirs.get(s)).split(path.sep).join('/');
  const matches = s => { const l = liveStories[s]; return l?.card?.format === CARD_FORMAT && l.hash === inputs.fingerprint(dirOf(s), l.shared ?? []); };
  const unchanged = new Set(changed ? stories.filter(matches) : []);
  if (changed) log(unchanged.size ? `${unchanged.size} of ${stories.length} stories match the live site: ${[...unchanged].join(', ')}` : 'no story matches the live site');
  const store = site.assets?.url ?? null;
  if (!store && !localAssets) fail('site.yaml', 'add an assets block with the url, bucket and endpoint of the store for the images and the objects the pages show, or build with --local-assets to show the files on this machine');
  // an image links its objects in the store, or with --local-assets its original: the copy in dist/assets/, else its
  // url, else the one in the store
  p.imageLinks = ({ keys, file, url, at }) => {
    if (!localAssets) return { original: store + keys.original, large: store + keys.large, small: store + keys.small };
    const one = file ? `assets/${keys.original}` : url ?? (store ? store + keys.original
      : fail(at, 'the original is not on this machine and image.yaml has no url, add the original to the folder or give it a url'));
    return { original: one, large: one, small: one };
  };
  // an engine's object, in the store or with --local-assets below dist/assets/, as a story page links it
  p.objectLink = key => store && !localAssets ? store + key : `../assets/${key}`;
  // story ids and language codes both name folders at the top of dist/
  // building one story, another story's story.yaml that does not read yet is left out of the checks
  const storyFile = s => path.join(p.storyDirs.get(s), 'story.yaml'), meta = s => [s, check(storySchema(e), lift(p.loadYaml(storyFile(s)), e, e.schemas.story), p.rel(storyFile(s)))];
  const metas = stories.flatMap(s => { if (!story || s === story) return [meta(s)]; try { return [meta(s)]; } catch { return []; } });
  site.langs = site.languages ?? [...new Set(metas.flatMap(([, m]) => m.languages))];
  site.defaultLang = site.default_language ?? site.langs[0];
  const codes = new Set([...site.langs, ...metas.flatMap(([, m]) => m.languages)]);
  for (const [s, m] of metas) if (codes.has(m.id)) fail(p.rel(storyFile(s)), `the story id "${m.id}" is also a language code, and both would be the folder dist/${m.id}/, so give the story another id`);
  // dist/assets/ holds the images and objects of a --local-assets build
  for (const [s, m] of metas) if (m.id === 'assets') fail(p.rel(storyFile(s)), `the story id "${m.id}" names the folder dist/${m.id}/ that holds the images and objects of a --local-assets build, so give the story another id`);
  // a story follows one story of the book and one story follows it, so the stories form chains with one next story
  const named = new Map(metas.map(([s, m]) => [m.id, [s, m]])), after = new Map();
  for (const [s, m] of metas) {
    if (!m.follows) continue;
    const at = p.rel(storyFile(s));
    if (m.follows === m.id) fail(at, 'follows names the story itself, name the story that comes before it');
    if (!named.has(m.follows)) fail(at, `follows names "${m.follows}", the stories are ${[...named.keys()].join(', ')}`);
    if (after.has(m.follows)) fail(at, `follows names "${m.follows}", which "${after.get(m.follows)}" follows already, so let one of the two follow the other`);
    after.set(m.follows, m.id);
    for (let seen = new Set([m.id]), cur = m; cur.follows; cur = named.get(cur.follows)[1]) {
      if (seen.has(cur.follows)) fail(at, `follows leads back to "${cur.follows}" in a circle, so one story of the circle follows none`);
      seen.add(cur.follows);
    }
  }
  site.context = siteContext({ url: site.url, languages: site.langs, defaultLanguage: site.defaultLang });
  if (story) site.stories = [metas.find(([s]) => s === story)[1].id];
  // the engine's checks across the stories, such as drawings that copy one another
  e.site({ root, cache, strict, log, stories: story ? [story] : changed ? stories.filter(s => !unchanged.has(s)) : only, fail, rel: p.rel, storyDirs: p.storyDirs, options });
  // the scripts: the engine's libraries from dist/vendor/, its own script and kitap's
  const { paths: vendorPaths, imports } = writeVendor(p.dist, e);
  // a module engine imports its libraries through an import map of the vendored copies, from the story folder
  const importMap = Object.keys(imports).length ? `<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(Object.entries(imports).map(([k, v]) => [k, `../${v}`])) })}</script>` : '';
  const tags = [importMap, ...vendorPaths.map(f => `<script src="../${f}"></script>`), ...(e.client?.styles ? [`<link rel="stylesheet" href="../${e.id}.css">`] : [])].filter(Boolean);
  const engineTag = engineJs ? `<script${e.client?.module ? ' type="module"' : ''} src="../${e.id}.js"></script>\n` : '';
  site.shell = APP.replace('<!--__SCRIPTS__-->', tags.join('\n')).replace('<script src="../kitap.js"></script>', `${engineTag}<script src="../kitap.js"></script>`);
  writeFile(path.join(p.dist, 'kitap.js'), APP_JS);
  if (engineJs) writeFile(path.join(p.dist, `${e.id}.js`), engineJs);
  if (e.client?.styles) writeFile(path.join(p.dist, `${e.id}.css`), fs.readFileSync(e.client.styles instanceof URL ? fileURLToPath(e.client.styles) : e.client.styles, 'utf8'));
  const cards = [], records = [];
  for (const s of story ? [story] : stories) {
    if (unchanged.has(s)) { cards.push(liveStories[s].card); continue; }
    const kept = only && !only.includes(s) && lastCard(s);
    if (kept) { cards.push(kept); continue; }
    log(`story ${s}`);
    const card = buildStory(p, p.storyDirs.get(s), site, e);
    const { i18n, objects, folderI18n, pageTexts, tree, ...saved } = card;
    writeCache(cardFile(s), { ...saved, local: localAssets });
    if (recording) { const shared = sharedFolders(card); records.push({ story: s, hash: inputs.fingerprint(dirOf(s), shared), shared, card: saved }); }
    cards.push(card);
  }
  // deploy reads what this build holds: every story with its folder in dist/, the ones built, and the live record
  const builtFile = path.join(p.dist, BUILT_FILE);
  if (recording) writeFile(builtFile, JSON.stringify({ format: RECORD_FORMAT, stories: stories.map((s, i) => [s, cards[i].id]), built: records, live: changed ? liveStories : {} }));
  else fs.rmSync(builtFile, { force: true });
  buildIndex(p, cards, site, e);
  // the Worker and kitap dev redirect the image paths of harita 0.4 to the originals, see routes.mjs
  const redirects = Object.fromEntries(cards.flatMap(c => Object.entries(c.redirects ?? {})).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  writeFile(path.join(p.dist, 'redirects.json'), JSON.stringify(redirects, null, 1) + '\n');
  // dist/ holds no objects of the store, and dist/images/ and dist/terrain/ of harita 0.4 go unless a story is named so
  const taken = new Set(metas.map(([, m]) => m.id));
  for (const d of [...(localAssets ? [] : ['assets']), 'images', 'terrain']) if (!taken.has(d)) fs.rmSync(path.join(p.dist, d), { recursive: true, force: true });
  // dist/assets/images/ keeps the originals a story in dist/ shows: the built ones, and the others from their cached cards
  const others = story ? stories.filter(s => s !== story).map(lastCard).filter(Boolean) : [];
  const imagesDir = path.join(p.dist, 'assets', 'images'), shown = new Set([...cards, ...others].flatMap(c => c.localKeys ?? []));
  for (const f of localAssets && exists(imagesDir) ? fs.readdirSync(imagesDir, { recursive: true }).sort().reverse() : []) {
    const full = path.join(imagesDir, f);
    if (fs.statSync(full).isDirectory()) { if (!fs.readdirSync(full).length) fs.rmdirSync(full); }
    else if (!shown.has(`images/${f.split(path.sep).join('/')}`)) fs.rmSync(full);
  }
  const built = cards.filter(c => c.objects);
  // a folder several stories use has one catalogue: its keys from every story, and the languages of all of them
  const merged = {};
  for (const c of built) for (const [dir, b] of Object.entries(c.folderI18n)) {
    const into = merged[dir] ??= { kind: b.kind, id: b.id, defaultLang: b.defaultLang, langs: new Set(), entries: new Map() };
    for (const l of b.langs) into.langs.add(l);
    for (const e of b.entries) if (!into.entries.has(e.key)) into.entries.set(e.key, e);
  }
  const folders = Object.fromEntries(Object.entries(merged).map(([dir, f]) => [dir, { ...f, langs: [...f.langs], entries: [...f.entries.values()] }]));
  return { dist: p.dist, themes: site.themes, engine: e, stories: cards.map(({ i18n, objects, folderI18n, pageTexts, localKeys, redirects, tree, coverOg, local, ...card }) => card),
    i18n: { stories: Object.fromEntries(built.map(c => [c.id, { dir: c.dir, entries: c.i18n, langs: c.languages, defaultLang: c.defaultLanguage, pages: c.pageTexts, folders: Object.keys(c.folderI18n) }])), site: p.siteEntries, siteLang: site.defaultLang, siteLangs: site.langs, folders },
    objects: built.map(c => ({ story: c.id, dir: c.dir, ...c.objects })), trees: built.map(c => ({ ...c.tree, dir: c.dir })), assets: site.assets ?? null };
}

// Build every story under root/content into root/dist. Returns the dist folder and one card per story. Pages link
// the images and objects in the asset store, and with strict the store must hold each of them. With localAssets the
// originals here and the engine's objects are made into dist/assets/. The engine keeps its own caches under cache.
// With changed it reads the record of the live site from site.yaml's url through get, and builds what differs.
export async function build({ root = process.cwd(), log = console.log, strict = false, cache = path.join(root, '.cache', 'kitap'), only = null, story = null, out = null, localAssets = false, engine = null, changed = false, get = globalThis.fetch, ...options } = {}) {
  const live = changed && !only && !story && !localAssets ? await liveRecord(root, get, log) : null;
  const { objects, trees, assets, engine: e, ...r } = buildPages({ root, log, strict, cache, only, story, out, localAssets, engine, changed, live, ...options });
  if (localAssets && e.make) await e.make({ stories: objects, cache, out: path.join(r.dist, 'assets'), log, options });
  else if (strict) await checkStore({ url: assets.url, trees, log, describe: e.describeObjects });
  return r;
}
