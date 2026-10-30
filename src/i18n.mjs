// Translatable strings. The default language is written inline as a plain string; other languages come from
// catalogues, content/<story>/i18n/<lang>.yaml for a story and i18n/<lang>.yaml for the site, keyed by the
// stable ids every piece of content already has, for example pages.occupation.title. An inline object with
// one entry per language keeps working and takes precedence for the languages it names.
import fs from 'fs';
import path from 'path';

// { a: { b: 'x' } } -> { 'a.b': 'x' }, so a catalogue may nest or stay flat
export function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out); else if (v != null && v !== '') out[key] = String(v);
  }
  return out;
}

// { 'a.b': 'x' } -> { a: { b: 'x' } }
export function unflatten(flat) {
  const out = {};
  for (const [k, v] of Object.entries(flat)) { const parts = k.split('.'); let o = out; parts.slice(0, -1).forEach(p => { o = o[p] = typeof o[p] === 'object' ? o[p] : {}; }); o[parts.at(-1)] = v; }
  return out;
}

// Reads <dir>/<lang>.yaml for every language that has one.
export function loadCatalogues(dir, langs, loadYaml) {
  const cats = {};
  for (const lang of langs) { const f = path.join(dir, lang + '.yaml'); if (fs.existsSync(f)) cats[lang] = flatten(loadYaml(f)); }
  return cats;
}

// One translator per story or site. tr(value, key) expands a field to one string per language and records
// the key with its source text, so catalogues can be written and gaps reported. A shared field, a name, citation
// or photo credit, may be translated but is not counted as missing when it is not.
export function translator({ langs, defaultLang, catalogues, where, fail }) {
  const entries = new Map();
  const missing = Object.fromEntries(langs.map(l => [l, []]));
  function tr(value, key, { shared = false } = {}) {
    const inline = typeof value === 'object' && value !== null ? value : null;
    const source = inline ? inline[defaultLang] : value;
    if (source == null) fail(where, `${key}: no "${defaultLang}" text, write it in ${defaultLang} or set default_language to the language it is in`);
    const out = {};
    for (const lang of langs) {
      const text = inline?.[lang] ?? catalogues[lang]?.[key] ?? (lang === defaultLang ? source : null);
      if (text == null) { if (!shared) missing[lang].push(key); out[lang] = source; } else out[lang] = String(text);
    }
    if (!entries.has(key)) entries.set(key, { key, source: String(source), values: out, shared, inline: inline ? Object.fromEntries(Object.entries(inline).filter(([l]) => l !== defaultLang)) : null });
    return out;
  }
  const report = () => Object.fromEntries(langs.filter(l => l !== defaultLang).map(l => [l, { total: [...entries.values()].filter(e => !e.shared).length, missing: [...new Set(missing[l])] }]));
  return { tr, entries, report };
}

// Text of a catalogue: every key with its English source as the comment above, existing or inline
// translations kept, keys that no longer exist moved to a commented block at the end.
export function catalogueText(lang, entries, existing, heading) {
  const q = s => JSON.stringify(s ?? '');
  const lines = [`# ${heading}`, `# Keys are stable ids, the comment above each one is the source text. Empty values fall back to the`, `# default language, and kitap build --strict reports them. Regenerate with: kitap i18n ${lang}`, ''];
  let filled = 0, total = 0;
  const emit = e => { const value = existing[e.key] ?? e.inline?.[lang] ?? ''; if (value && !e.shared) filled++; if (!e.shared) total++; lines.push(`# ${e.source.replace(/\n/g, ' ')}`, `${e.key}: ${q(value)}`, ''); };
  entries.filter(e => !e.shared).forEach(emit);
  // a name, citation or credit is listed only with its own form in the language, the rest show as in the source
  const shared = entries.filter(e => e.shared && (existing[e.key] || e.inline?.[lang]));
  if (shared.length) { lines.push('# Names, citations and credits with their own form in this language. Any other shows as written in the source.', ''); shared.forEach(emit); }
  const stale = Object.keys(existing).filter(k => !entries.some(e => e.key === k));
  if (stale.length) { lines.push('# No longer used by the content:'); for (const k of stale) lines.push(`# ${k}: ${q(existing[k])}`); lines.push(''); }
  return { text: lines.join('\n'), filled, total };
}
