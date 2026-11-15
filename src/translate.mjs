// kitap i18n [<lang>] [--story id] [--stale | --stamp | --check]: builds quietly to collect every string, then writes
// the <lang>.yaml catalogues of each story, folder and the site. --stale adds a work list per story, --stamp writes the
// stamps instead, --check compares one story's translation with its source and writes nothing.
// Without a language, --stale and --stamp cover every language of the stories and the site from the one build.
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { buildPages, uiCatalogue } from './build.mjs';
import { flatten, catalogueText } from './i18n.mjs';
import { blocksOf, stalePage, staleStrings, stampsOf, stampsFile, readStamps, writeStamps, writeStale } from './stamps.mjs';
import { plural } from './util.mjs';

const existingOf = file => fs.existsSync(file) ? flatten(yaml.load(fs.readFileSync(file, 'utf8')) ?? {}) : {};
// one story builds alone into a folder thrown away after, so a half edited story elsewhere does not stop it
function collect({ root, story, engine }) {
  const out = story && fs.mkdtempSync(path.join(os.tmpdir(), 'kitap-i18n-'));
  try { return buildPages({ root, log: () => {}, story, out, localAssets: true, engine }); } finally { if (out) fs.rmSync(out, { recursive: true, force: true }); }
}

export function i18n({ root = process.cwd(), lang: given, story, log = console.log, engine = null, stale = false, stamp = false } = {}) {
  if (!given && !stale && !stamp) throw new Error('usage: kitap i18n <lang> [--story id] [--stale | --stamp], or without the language for every one with --stale or --stamp');
  if (stale && stamp) throw new Error('kitap i18n takes --stale or --stamp, one of them');
  const r = collect({ root, story, engine });
  const written = [];
  const rel = f => path.relative(root, f).split(path.sep).join('/');
  const stories = Object.values(r.i18n.stories);
  // every language some story or the site is translated into, when none is given
  const langs = given ? [given] : [...new Set([...stories.flatMap(s => s.langs.filter(l => l !== s.defaultLang)), ...(story ? [] : r.i18n.siteLangs.filter(l => l !== r.i18n.siteLang))])];

  const forLang = lang => {
    const catalogue = dir => path.join(root, dir, 'i18n', lang + '.yaml');
    // a folder has a catalogue in each language a story shows it in, other than its own default language
    const folderHas = f => lang !== f.defaultLang && f.langs.includes(lang);
    const staleFile = id => path.join(root, '.cache', 'kitap', 'stale', id, lang + '.yaml');
    // the stories the language is a translation of; a story that left the language keeps no work list
    const storiesIn = () => Object.entries(r.i18n.stories).filter(([id, s]) => {
      const skip = !s.langs.includes(lang) ? 'not in languages' : lang === s.defaultLang ? 'the default language' : null;
      if (skip) { if (given) log(`${id} ${lang}: ${skip}`); fs.rmSync(staleFile(id), { force: true }); }
      return !skip;
    });
    const siteIn = !story && lang !== r.i18n.siteLang;

    if (stamp) {
      const stampFile = (dir, pages, entries, defaultLang, what) => {
        const file = stampsFile(path.join(root, dir), lang);
        const { pages: ps, strings, skipped } = stampsOf({ pages, entries, lang, defaultLang, existing: existingOf(catalogue(dir)) });
        for (const s of skipped) log(s);
        writeStamps(file, { pages: ps, strings }, `# ${lang} stamps for ${what}: the hash of the ${defaultLang} source each translation was made from.\n# Written by kitap i18n ${lang} --stamp after a review. kitap i18n ${lang} --stale lists what changed since.`);
        log(`wrote ${rel(file)}: ${Object.keys(ps).length ? `${plural(Object.keys(ps).length, 'page')}, ` : ''}${plural(Object.keys(strings).length, 'string')}`);
        written.push(file);
      };
      for (const [id, s] of storiesIn()) stampFile(s.dir, s.pages, s.entries, s.defaultLang, `the story "${id}"`);
      for (const [dir, f] of Object.entries(r.i18n.folders)) if (folderHas(f)) stampFile(dir, {}, f.entries, f.defaultLang, `the ${f.kind} "${f.id}"`);
      if (siteIn) stampFile('', {}, r.i18n.site, r.i18n.siteLang, 'the site');
      return;
    }

    const write = (file, entries, heading) => {
      const { text, filled, total } = catalogueText(lang, entries, existingOf(file), heading);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      log(`wrote ${rel(file)}: ${filled} of ${total} strings translated`);
      written.push(file);
    };
    for (const [id, { dir, entries }] of Object.entries(r.i18n.stories)) write(catalogue(dir), entries, `${lang} strings for the story "${id}".`);
    // an image folder's or an engine folder's catalogues sit in its folder, for each language a story using it has
    for (const [dir, f] of Object.entries(r.i18n.folders)) if (folderHas(f)) write(catalogue(dir), f.entries, `${lang} strings for the ${f.kind} "${f.id}".`);
    if (!story) write(catalogue(''), r.i18n.site, `${lang} strings for the site.`);
    if (!story && lang !== 'en') {
      const u = uiCatalogue(root, lang, r.themes, r.engine), file = path.join(root, 'i18n', 'ui', lang + '.yaml');
      if (u.missing.length || fs.existsSync(file)) {
        const { text, filled, total } = catalogueText(lang, u.entries, u.existing, `${lang} interface strings: buttons, labels, messages, theme names. Overrides what kitap and the engine ship.`);
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
        log(`wrote ${rel(file)}: ${filled} of ${total} strings translated`); written.push(file);
      } else log(`interface: kitap and the engine ship all ${u.entries.length} strings for ${lang}`);
    }
    if (!stale) return;

    // the work list of a story, or of the site: its pages, its catalogue and the catalogues of the folders it uses
    const listFor = (id, { dir, pages = {}, entries, defaultLang, folders = [] }, what) => {
      const file = staleFile(id);
      const list = { pages: {}, strings: [] }, n = { blocks: 0, strings: 0, missing: 0, pages: 0, unstamped: 0 };
      const stamps = readStamps(stampsFile(path.join(root, dir), lang));
      for (const [pid, p] of Object.entries(pages)) {
        const source = p.texts[defaultLang];
        if (source == null) continue;
        const got = stalePage({ source, text: p.texts[lang] ?? null, stamps: stamps?.pages[pid] ?? null, defaultLang, lang });
        if (!got) continue;
        list.pages[pid] = { file: `${p.dir.split(path.sep).join('/')}/text/${lang}.md`, ...got };
        if (got.blocks) n.blocks += got.blocks.length; else if (got.state === 'missing') n.missing++; else n.pages++;
      }
      const strings = (d, es, dl) => {
        const cat = catalogue(d);
        list.strings.push(...staleStrings({ entries: es, lang, existing: existingOf(cat), stamps: readStamps(stampsFile(path.join(root, d), lang))?.strings, file: rel(cat), defaultLang: dl }));
      };
      strings(dir, entries, defaultLang);
      for (const d of folders) { const f = r.i18n.folders[d]; if (f && folderHas(f)) strings(d, f.entries, f.defaultLang); }
      for (const s of list.strings) if (s.state === 'unstamped') n.unstamped++; else n.strings++;
      const parts = [n.blocks && plural(n.blocks, 'block'), n.strings && plural(n.strings, 'string'), n.missing && `${plural(n.missing, 'page')} missing`,
        (n.pages || n.unstamped) && `${[n.pages && plural(n.pages, 'page'), n.unstamped && plural(n.unstamped, 'string')].filter(Boolean).join(' and ')} unstamped`].filter(Boolean);
      log(`${id} ${lang}: ${parts.length ? parts.join(', ') : 'up to date'}`);
      if (!parts.length) { fs.rmSync(file, { force: true }); return; }
      writeStale(file, list, `# ${lang} work for ${what}: what changed in the ${defaultLang} source since the last stamp, and what has no\n# translation yet. Edit the files named, then run kitap i18n ${lang} --stamp${story ? ` --story ${story}` : ''}.`);
      written.push(file);
    };
    for (const [id, s] of storiesIn()) listFor(id, s, `the story "${id}"`);
    if (siteIn) listFor('site', { dir: '', entries: r.i18n.site, defaultLang: r.i18n.siteLang }, 'the site');
  };
  for (const lang of langs) forLang(lang);
  return written;
}

// the digits of every script the writing rules use, read as 0-9: Arabic-Indic, Persian, Devanagari, Bengali, Thai, full width
const ZEROS = [0x660, 0x6f0, 0x966, 0x9e6, 0xe50, 0xff10];
const asciiDigits = s => s.replace(/\p{Nd}/gu, c => { const cp = c.codePointAt(0), z = ZEROS.find(z => cp >= z && cp <= z + 9); return z == null ? c : String(cp - z); });
const shapeOf = md => ({
  images: [...md.matchAll(/^@image\s+(\S+)/gm)].map(m => m[1]),
  links: [...md.matchAll(/\]\(@([^)\s]+)\)/g)].map(m => m[1]).sort(),
  paragraphs: blocksOf(md).filter(b => !/^@image\s/.test(b)).length,
  headings: (md.match(/^#{1,6}\s/gm) ?? []).length,
});
// a four digit number standing alone, so 250,000 and 1.5 are not read as years
const years = md => [...new Set([...asciiDigits(md).matchAll(/(?<![\d.,])\d{4}(?![\d]|[.,]\d)/g)].map(m => m[0]))];

// kitap i18n <lang> --story <id> --check: the problems of one story's translation, as far as code can tell. Per page:
// the text exists, its @image lines and link ids match the source, it has as many paragraphs and headings, and every
// four digit number of the source appears in it. Per catalogue of the story and of the folders it uses: no empty value.
export function checkTranslation({ root = process.cwd(), lang, story, engine = null } = {}) {
  if (!lang || !story) throw new Error('usage: kitap i18n <lang> --story <id> --check');
  const r = collect({ root, story, engine }), s = r.i18n.stories[story], src = s.defaultLang;
  if (lang === src) throw new Error(`${story}: ${lang} is the story's default language, name a language it is translated into`);
  if (!s.langs.includes(lang)) throw new Error(`${story}: add ${lang} to languages in story.yaml, then run the check again`);
  const problems = [], list = ids => ids.join(', ') || 'none';
  const posix = f => f.split(path.sep).join('/');
  for (const p of Object.values(s.pages)) {
    const source = p.texts[src], text = p.texts[lang], where = posix(path.relative(s.dir, p.dir));
    if (source == null) continue;
    if (text == null) { problems.push(`${where}: no text/${lang}.md`); continue; }
    const a = shapeOf(source), b = shapeOf(text);
    if (a.images.join() !== b.images.join()) problems.push(`${where}: @image lines ${list(b.images)}, the ${src} text has ${list(a.images)}`);
    if (a.links.join() !== b.links.join()) problems.push(`${where}: link ids ${list(b.links)}, the ${src} text has ${list(a.links)}`);
    if (a.paragraphs !== b.paragraphs) problems.push(`${where}: ${plural(b.paragraphs, 'paragraph')}, the ${src} text has ${a.paragraphs}`);
    if (a.headings !== b.headings) problems.push(`${where}: ${plural(b.headings, 'heading')}, the ${src} text has ${a.headings}`);
    const got = new Set(years(text)), lost = years(source).filter(y => !got.has(y));
    if (lost.length) problems.push(`${where}: ${lost.join(', ')} of the ${src} text ${lost.length === 1 ? 'does' : 'do'} not appear`);
  }
  const catalogue = (dir, entries) => {
    const file = path.join(root, dir, 'i18n', lang + '.yaml'), existing = existingOf(file);
    const empty = entries.filter(e => !e.shared && !(e.inline?.[lang] ?? existing[e.key])).map(e => e.key);
    if (empty.length) problems.push(`${posix(path.relative(root, file))}: ${empty.length} empty, ${empty.slice(0, 5).join(', ')}${empty.length > 5 ? ', ...' : ''}`);
  };
  catalogue(s.dir, s.entries);
  for (const d of s.folders) { const f = r.i18n.folders[d]; if (f && lang !== f.defaultLang && f.langs.includes(lang)) catalogue(d, f.entries); }
  return problems;
}
