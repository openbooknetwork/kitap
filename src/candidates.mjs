// kitap image-candidates: searches Wikimedia Commons for each page's queries and articles, and downloads what it finds
// to <story folder>/.candidates/<page>/ for review, listed with author, license and source in .candidates/index.yaml.
// kitap image then adds a chosen one by its url. A file the book holds already, by its Commons page or its bytes, is
// listed with held: <id> and not kept.
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { storyFolders } from './folders.mjs';
import { imageIndex, findImage } from './image.mjs';

const API = 'https://commons.wikimedia.org/w/api.php';
const BITMAP = /\.(jpe?g|png|tiff?)$/i;
// an article is a Wikipedia URL or an English Wikipedia title
const articleApi = a => { const m = a.match(/^https?:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/([^?#]+)/); return m ? [`https://${m[1]}.wikipedia.org/w/api.php`, decodeURIComponent(m[2]).replace(/_/g, ' ')] : ['https://en.wikipedia.org/w/api.php', a]; };
const strip = s => String(s ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// queries is a YAML file keyed by story id, then by page id: { queries: [search terms], articles: [titles or URLs],
// files: [Commons file names] }, or a bare list of search terms. pages refetches those pages, out writes into
// .candidates/<out>/ so agents fetching at the same time keep separate index files. pause scales the waits.
export async function imageCandidates({ root = process.cwd(), story, queries, limit = 6, pages = null, out = '', log = console.log, fetch = globalThis.fetch, pause = 1 } = {}) {
  const stories = storyFolders(path.join(root, 'content'), p => path.relative(root, p)); // full paths by folder name
  if (!stories.has(story)) throw new Error(`"${story}" is not a story folder under content/`);
  if (!queries) throw new Error('name the queries file with --queries <file>: YAML keyed by story, then page, each with queries, articles or files');
  const spec = yaml.load(fs.readFileSync(path.resolve(root, queries), 'utf8'))?.[story];
  if (!spec) throw new Error(`${queries}: no queries for the story "${story}"`);
  const outDir = path.join(stories.get(story), '.candidates', out);
  fs.mkdirSync(outDir, { recursive: true });

  // Wikimedia asks for a contact in the user agent and throttles unnamed clients harder
  const siteFile = path.join(root, 'site.yaml'), site = fs.existsSync(siteFile) ? yaml.load(fs.readFileSync(siteFile, 'utf8')) ?? {} : {};
  const title = typeof site.title === 'object' ? Object.values(site.title)[0] : site.title;
  const headers = { 'User-Agent': `${title ?? 'kitap'} image-candidates (${site.repository ?? site.url ?? 'https://github.com/openbooknetwork/kitap'})` };
  const sleep = ms => new Promise(r => setTimeout(r, ms * pause));
  // Commons answers 429 when asked too fast: wait as told, or doubling from two seconds, up to six tries
  async function get(url) {
    for (let attempt = 0; ; attempt++) {
      // a dropped connection is retried like a 5xx
      const res = await fetch(url, { headers }).catch(e => { if (attempt >= 6) throw e; return { ok: false, status: 599, headers: new Headers() }; });
      if (res.ok) return res;
      if ((res.status === 429 || res.status >= 500) && attempt < 6) {
        const wait = Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** attempt;
        log(`  ${res.status}, waiting ${wait / 1000}s`); await sleep(wait); continue;
      }
      throw new Error(`${res.status} for ${url}`);
    }
  }
  const api = async (params, base = API) => (await get(base + '?' + new URLSearchParams({ format: 'json', ...params }))).json();

  // resume: pages already in index.yaml are kept and skipped
  const indexFile = path.join(outDir, 'index.yaml');
  const index = fs.existsSync(indexFile) ? yaml.load(fs.readFileSync(indexFile, 'utf8')) ?? {} : {};
  const save = () => fs.writeFileSync(indexFile, yaml.dump(index, { lineWidth: 120 }));
  const held = imageIndex({ root });
  const seen = new Set(Object.values(index).flat().map(c => 'File:' + c.title));
  for (const [page, s] of Object.entries(spec)) {
    if (pages && !pages.includes(page)) continue;
    if (pages && index[page]) { for (const c of index[page]) seen.delete('File:' + c.title); delete index[page]; fs.rmSync(path.join(outDir, page), { recursive: true, force: true }); }
    if (index[page]) { log(`${page}: done earlier, skipping`); continue; }
    const terms = Array.isArray(s) ? s : s.queries ?? [], files = Array.isArray(s) ? [] : s.files ?? [], articles = Array.isArray(s) ? [] : s.articles ?? [];
    const titles = files.map(f => f.startsWith('File:') ? f : 'File:' + f);
    // every bitmap an article uses; files local to Wikipedia, usually non-free, have no Commons record and drop out below
    for (const a of articles) {
      const [base, t] = articleApi(a);
      const r = await api({ action: 'query', prop: 'images', titles: t, imlimit: 'max', redirects: 1 }, base);
      const found = Object.values(r.query?.pages ?? {});
      if (!found.length || found.some(p => 'missing' in p)) log(`  no article "${t}"`);
      for (const p of found) for (const im of p.images ?? []) if (BITMAP.test(im.title)) titles.push(im.title);
      await sleep(1000);
    }
    for (const q of terms) {
      const r = await api({ action: 'query', list: 'search', srsearch: `${q} filetype:bitmap`, srnamespace: 6, srlimit: limit * 2 });
      const hits = (r.query?.search ?? []).map(h => h.title).filter(t => BITMAP.test(t) && !seen.has(t) && !titles.includes(t));
      titles.push(...hits.slice(0, limit));
      await sleep(1000);
    }
    const picked = [...new Set(titles)].filter(t => !seen.has(t));
    if (!picked.length) { log(`${page}: nothing found`); continue; }
    const infoPages = [];
    for (let i = 0; i < picked.length; i += 50) { // the API takes at most 50 titles per call
      const info = await api({ action: 'query', prop: 'imageinfo', titles: picked.slice(i, i + 50).join('|'), iiprop: 'url|extmetadata|size', iiurlwidth: 1280 }); // a standard thumbnail step, Wikimedia throttles other widths
      infoPages.push(...Object.values(info.query?.pages ?? {}));
    }
    const dir = path.join(outDir, page);
    fs.mkdirSync(dir, { recursive: true });
    index[page] = [];
    let n = 0;
    for (const p of infoPages) {
      const ii = p.imageinfo?.[0]; if (!ii) continue;
      const meta = ii.extmetadata ?? {};
      // the extension comes from the downloaded thumbnail, so a long title cut to 80 characters keeps one
      const url = ii.thumburl ?? ii.url, ext = path.extname(new URL(url).pathname).toLowerCase();
      const base = p.title.replace(/^File:/, '').replace(/\.\w+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 80);
      const commonsPage = `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}`;
      const entry = { title: p.title.replace(/^File:/, ''), page: commonsPage, url, author: strip(meta.Artist?.value), license: strip(meta.LicenseShortName?.value),
        date: strip(meta.DateTimeOriginal?.value), description: strip(meta.ImageDescription?.value).slice(0, 300), width: ii.width, height: ii.height };
      seen.add(p.title);
      const known = findImage(held, { source: commonsPage });
      if (known) { index[page].push({ file: null, held: known.id, ...entry }); log(`  held already: ${known.id}`); continue; }
      const name = `${String(++n).padStart(2, '0')}-${base}${ext}`, file = path.join(dir, name);
      try { fs.writeFileSync(file, Buffer.from(await (await get(url)).arrayBuffer())); } catch (e) { log(`  skip ${p.title}: ${e.message}`); continue; }
      // the same bytes in an image folder that names no source: the download goes
      const same = findImage(held, { file });
      if (same) { fs.rmSync(file); index[page].push({ file: null, held: same.id, ...entry }); log(`  held already: ${same.id}`); continue; }
      index[page].push({ file: name, ...entry });
      await sleep(800);
    }
    log(`${page}: ${index[page].length} candidates`);
    save();
  }
  log(`wrote ${path.relative(root, indexFile)}`);
  return index;
}
