// kitap i18n [<lang>] [--story id] [--stale | --stamp]: builds quietly to collect every string, then writes the <lang>.yaml
// catalogues of each story, folder and the site. --stale adds a work list per story, --stamp writes the stamps instead.
// Without a language, --stale and --stamp cover every language of the stories and the site from the one build.
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { buildPages, uiCatalogue } from './build.mjs';
import { flatten, catalogueText } from './i18n.mjs';
import { stalePage, staleStrings, stampsOf, stampsFile, readStamps, writeStamps, writeStale } from './stamps.mjs';
import { plural } from './util.mjs';

export function i18n({ root = process.cwd(), lang: given, story, log = console.log, engine = null, stale = false, stamp = false } = {}) {
  if (!given && !stale && !stamp) throw new Error('usage: kitap i18n <lang> [--story id] [--stale | --stamp], or without the language for every one with --stale or --stamp');
  if (stale && stamp) throw new Error('kitap i18n takes --stale or --stamp, one of them');
  // one story builds alone into a folder thrown away after, so a half edited story elsewhere does not stop it
  const out = story && fs.mkdtempSync(path.join(os.tmpdir(), 'kitap-i18n-'));
  let r;
  try { r = buildPages({ root, log: () => {}, story, out, localAssets: true, engine }); } finally { if (out) fs.rmSync(out, { recursive: true, force: true }); }
  const written = [];
  const rel = f => path.relative(root, f).split(path.sep).join('/');
  const existingOf = file => fs.existsSync(file) ? flatten(yaml.load(fs.readFileSync(file, 'utf8')) ?? {}) : {};
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
