// kitap sources: downloads the reading a story is written from. Each <name>.urls file of the story folder lists URLs,
// one per line with # for comments, and its files go to .<name>/ beside it: wikipedia.urls fills .wikipedia/. A
// Wikipedia article is saved as <Title>.wiki, its wikitext, and <Title>.infobox.txt. A PDF is saved as it is, with a
// .txt beside it where pdftotext is installed. Any other page is saved as its text, under its URL.
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import yaml from 'js-yaml';
import { storyFolders } from './folders.mjs';

const WIKI = /^https?:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/([^?#]+)/;
// the magic word of a redirect is translated per wiki
const REDIRECT = /^#(?:REDIRECT|PŘESMĚRUJ|PŘESMĚROVÁNÍ|WEITERLEITUNG|PRZEKIERUJ|YÖNLENDİRME)\s*\[\[([^\]#|]+)/iu;
const BLOCK = /<\/?(?:p|div|section|article|main|header|footer|nav|aside|ul|ol|li|dl|dt|dd|table|tr|h[1-6]|br|hr|blockquote|figure|figcaption|pre|title)\b[^>]*>/gi;
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
// a page with less text than this drew its content with a script
const THIN = 400;

// The first {{Infobox ...}} template, found by counting braces
function infobox(text) {
  const start = text.search(/\{\{\s*Infobox/i);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length - 1; i++) {
    if (text.startsWith('{{', i)) { depth++; i++; }
    else if (text.startsWith('}}', i)) { depth--; i++; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}
const stripRefs = s => s
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<ref[^>]*\/>/gi, '')
  .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
  .replace(/\{\{(?:efn|sfn|sfnm|harvnb|refn)\b[^{}]*\}\}/gi, '')
  .replace(/\n{3,}/g, '\n\n');

// The text a reader sees on an HTML page, one line per block, without its menus, footer and forms
export const pageText = html => html
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<(script|style|noscript|svg|template|nav|footer|form)\b[\s\S]*?<\/\1>/gi, '')
  .replace(BLOCK, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] !== '#' ? NAMED[e.toLowerCase()] ?? m : String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))))
  .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');

// A file name for a URL: its host and path, with every other run of characters as one hyphen. A long path keeps its end.
const slug = url => {
  const u = new URL(url), clean = t => t.replace(/[^A-Za-z0-9.]+/g, '-').replace(/^-|-$/g, '');
  const host = clean(u.hostname.replace(/^www\./, '')), rest = clean(`${u.pathname.replace(/\.(?:pdf|html?)$/i, '')}${u.search}`);
  return clean(`${host}-${rest.slice(-(100 - host.length))}`);
};

// story is a story's folder name, or a folder of content/ that has no story.yaml yet. pause scales the waits and
// pdftotext names the binary. Returns the files written, the files kept from an earlier run and the URLs that failed.
export async function sources({ root = process.cwd(), story, log = console.log, fetch = globalThis.fetch, pause = 1, pdftotext = 'pdftotext' } = {}) {
  const rel = p => path.relative(root, p);
  const dir = storyFolders(path.join(root, 'content'), rel).get(story) ?? path.join(root, 'content', story ?? '');
  if (!story || !fs.existsSync(dir)) throw new Error(`"${story}" is not a folder under content/`);
  const lists = fs.readdirSync(dir).filter(f => f.endsWith('.urls')).sort();
  if (!lists.length) throw new Error(`${rel(dir)} has no .urls file: list the URLs one per line in ${rel(path.join(dir, 'references.urls'))}`);

  // Wikimedia asks for a contact in the user agent, and other sites refuse a client that names no browser
  const siteFile = path.join(root, 'site.yaml'), site = fs.existsSync(siteFile) ? yaml.load(fs.readFileSync(siteFile, 'utf8')) ?? {} : {};
  const title = typeof site.title === 'object' ? Object.values(site.title)[0] : site.title;
  const wikiAgent = `${title ?? 'kitap'} sources (${site.repository ?? site.url ?? 'https://github.com/openbooknetwork/kitap'})`;
  const get = async (url, agent = 'Mozilla/5.0 (compatible; kitap sources)') => {
    const res = await fetch(url, { headers: { 'User-Agent': agent }, redirect: 'follow', signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`the site answered ${res.status}`);
    // a page that is gone often leads to the site's front page
    if (res.url && new URL(res.url).pathname === '/' && new URL(url).pathname !== '/') throw new Error(`the address leads to the front page ${res.url}`);
    return res;
  };
  const wikitext = async (lang, name) => {
    const text = await (await get(`https://${lang}.wikipedia.org/w/index.php?title=${encodeURIComponent(name)}&action=raw`, wikiAgent)).text();
    const to = text.match(REDIRECT);
    return to ? wikitext(lang, to[1].trim().replace(/ /g, '_')) : text;
  };
  let noPdftotext = false;
  // The .txt beside a PDF, written once
  const pdfText = file => {
    const txt = file.replace(/\.pdf$/, '.txt');
    if (noPdftotext || fs.existsSync(txt)) return;
    if (spawnSync(pdftotext, ['-layout', file, txt]).error) noPdftotext = true;
  };

  const written = [], kept = [], failed = [];
  for (const list of lists) {
    const out = path.join(dir, `.${list.slice(0, -'.urls'.length)}`);
    fs.mkdirSync(out, { recursive: true });
    const urls = fs.readFileSync(path.join(dir, list), 'utf8').split('\n').map(l => l.replace(/(^|\s)#.*/, '').trim()).filter(Boolean);
    for (const url of urls) {
      const wiki = url.match(WIKI);
      const base = path.join(out, wiki ? decodeURIComponent(wiki[2]).replace(/[\/\\:*?"<>|]/g, '_') : slug(url));
      const file = wiki ? `${base}.wiki` : fs.existsSync(`${base}.pdf`) ? `${base}.pdf` : `${base}.txt`;
      // a page saved from a browser as .html is read like a fetched one
      if (!wiki && !fs.existsSync(file) && fs.existsSync(`${base}.html`)) fs.writeFileSync(file, `${url}\n\n${pageText(fs.readFileSync(`${base}.html`, 'utf8'))}\n`);
      if (fs.existsSync(file)) {
        if (file.endsWith('.pdf')) pdfText(file);
        kept.push(rel(file));
        continue;
      }
      try {
        if (wiki) {
          const text = await wikitext(wiki[1], decodeURIComponent(wiki[2])), box = infobox(text);
          fs.writeFileSync(file, text);
          fs.writeFileSync(`${base}.infobox.txt`, `${url}\n\n${box ? stripRefs(box) : '(no infobox)'}\n`);
          written.push(rel(file));
        } else {
          const bytes = Buffer.from(await (await get(url)).arrayBuffer());
          if (bytes.subarray(0, 5).toString() === '%PDF-') {
            fs.writeFileSync(`${base}.pdf`, bytes);
            pdfText(`${base}.pdf`);
            written.push(rel(`${base}.pdf`));
          } else {
            const raw = bytes.toString('utf8'), text = /<html|<body|<!doctype html/i.test(raw) ? pageText(raw) : raw.trim();
            if (text.length < THIN) throw new Error(`the page gave ${text.length} characters of text`);
            fs.writeFileSync(file, `${url}\n\n${text}\n`);
            written.push(rel(file));
          }
        }
        log(`ok    ${written.at(-1)}`);
      } catch (err) {
        failed.push(url);
        log(`FAILED ${url}\n      ${err.message}${wiki ? '' : `: save it from a browser as ${rel(base)}.html or .pdf`}`);
      }
      await new Promise(r => setTimeout(r, 300 * pause)); // stays inside Wikipedia's rate limits
    }
  }
  if (noPdftotext) log(`pdftotext is not installed, so the PDFs have no .txt beside them: brew install poppler, then run this again`);
  log(`\n${written.length} fetched, ${kept.length} kept, ${failed.length} failed in ${rel(dir)}`);
  return { written, kept, failed };
}
