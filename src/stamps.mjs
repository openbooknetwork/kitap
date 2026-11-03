// Stamps: the hash of the source each translated paragraph and catalogue value was made from, in i18n/stamps/<lang>.yaml
// of a story, a folder and the site. kitap i18n --stamp writes them after a review, --stale diffs them against the source.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import yaml from 'js-yaml';

// a text's blocks, split on blank lines: paragraphs, headings and @image lines alike
export const blocksOf = md => md.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
// rewrapping a paragraph keeps its stamp
export const stampOf = text => crypto.createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 8);

// The diff of a page's stamps against the hashes of its source by longest common subsequence: in a run outside it,
// removed and new blocks pair up in order as changed ones. Positions count from 0, at in the source, old in the stamps.
export function alignBlocks(stamps, hashes) {
  const n = stamps.length, m = hashes.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = stamps[i] === hashes[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = [];
  let i = 0, j = 0, removed = [], added = [];
  const flush = () => {
    const k = Math.min(removed.length, added.length);
    for (let x = 0; x < k; x++) ops.push({ state: 'changed', at: added[x], old: removed[x] });
    for (const old of removed.slice(k)) ops.push({ state: 'removed', old });
    for (const at of added.slice(k)) ops.push({ state: 'new', at });
    removed = []; added = [];
  };
  while (i < n || j < m) {
    if (i < n && j < m && stamps[i] === hashes[j]) { flush(); i++; j++; }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) added.push(j++);
    else removed.push(i++);
  }
  flush();
  return ops;
}

// What a translator has to do on one page, null when it is up to date. source and text are the Markdown of the
// default language and of lang, stamps the page's recorded hashes. A block's position counts from 1.
export function stalePage({ source, text, stamps, defaultLang, lang }) {
  if (text == null) return { state: 'missing' };
  if (!stamps) return { state: 'unstamped' };
  const blocks = blocksOf(source), hashes = blocks.map(stampOf), own = blocksOf(text);
  // the translation's blocks sit at the stamps' positions until it is edited, then at the source's
  const byOld = own.length === stamps.length, byNew = own.length === hashes.length;
  if (!byOld && !byNew) return { state: 'unstamped' };
  const ops = alignBlocks(stamps, hashes);
  if (!ops.length) return null;
  return { blocks: ops.map(o => {
    const out = { ...(o.at != null ? { at: o.at + 1 } : {}), state: o.state };
    if (o.at != null) out[defaultLang] = blocks[o.at];
    const i = byOld ? o.old : o.at;
    if (i != null && own[i] != null) out[lang] = own[i];
    return out;
  }) };
}

// What a translator has to do in one catalogue: entries are the build's, existing the catalogue as read, stamps its
// recorded hashes, file the catalogue's path for the list. A value written inline in the content is listed as such.
export function staleStrings({ entries, lang, existing, stamps, file, defaultLang }) {
  const out = [];
  for (const e of entries) {
    const inline = e.inline?.[lang] ?? null, value = inline ?? existing[e.key] ?? '';
    const where = inline != null ? { inline: true } : { file };
    if (!value) { if (e.shared !== true) out.push({ key: e.key, ...where, state: 'new', [defaultLang]: e.source }); continue; }
    const stamp = stamps?.[e.key];
    if (!stamp) out.push({ key: e.key, ...where, state: 'unstamped' });
    else if (stamp !== stampOf(e.source)) out.push({ key: e.key, ...where, state: 'changed', [defaultLang]: e.source, [lang]: value });
  }
  return out;
}

// The stamps of what holds a translation: every page with as many blocks as its source, every key with a value.
// skipped names the pages whose block count differs.
export function stampsOf({ pages = {}, entries = [], lang, defaultLang, existing = {} }) {
  const out = { pages: {}, strings: {} }, skipped = [];
  for (const [pid, p] of Object.entries(pages)) {
    const source = p.texts[defaultLang], text = p.texts[lang];
    if (source == null || text == null) continue;
    const blocks = blocksOf(source), own = blocksOf(text).length;
    if (own !== blocks.length) { skipped.push(`${pid}: ${own} blocks, the ${defaultLang} text has ${blocks.length}, not stamped`); continue; }
    out.pages[pid] = blocks.map(stampOf);
  }
  for (const e of entries) if (e.inline?.[lang] ?? existing[e.key]) out.strings[e.key] = stampOf(e.source);
  return { ...out, skipped };
}

export const stampsFile = (dir, lang) => path.join(dir, 'i18n', 'stamps', lang + '.yaml');

// a hash read back as a string, whatever YAML made of it
export function readStamps(file) {
  if (!fs.existsSync(file)) return null;
  let s;
  try { s = yaml.load(fs.readFileSync(file, 'utf8')) ?? {}; } catch (err) { throw new Error(`${file}: ${err.message}, delete it and run kitap i18n --stamp again`); }
  const list = (k, v) => { if (!Array.isArray(v)) throw new Error(`${file}: pages.${k} is not a list of stamps, delete the file and run kitap i18n --stamp again`); return v.map(String); };
  return { pages: Object.fromEntries(Object.entries(s.pages ?? {}).map(([k, v]) => [k, list(k, v)])),
    strings: Object.fromEntries(Object.entries(s.strings ?? {}).map(([k, v]) => [k, String(v)])) };
}

export function writeStamps(file, { pages, strings }, heading) {
  const body = { ...(Object.keys(pages).length ? { pages } : {}), strings };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${heading}\n${yaml.dump(body, { flowLevel: 2, lineWidth: -1 })}`);
}

export function writeStale(file, { pages, strings }, heading) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${heading}\n${yaml.dump({ pages, strings }, { lineWidth: -1 })}`);
}
