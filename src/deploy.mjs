// kitap deploy: puts dist/ in the pages bucket the Worker serves, see worker.mjs. The files the bucket lacks or holds
// in another version go up, scripts and stylesheets first, and the keys dist/ no longer holds go. After a build that
// wrote dist/.kitap-build.json, a story it left unbuilt keeps its files in the bucket, and the live record goes up last.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import yaml from 'js-yaml';
import { check, Site } from './schema.mjs';
import { storeWriter, pool } from './store.mjs';
import { typeOf } from './routes.mjs';
import { mb, plural, progressLine } from './util.mjs';
import { RECORD_KEY, BUILT_FILE, RECORD_FORMAT } from './build.mjs';

const CACHE = 'public, max-age=600';

// Puts root/dist in site.yaml's pages.bucket, in the account of assets.endpoint, and deletes the keys
// dist/ lacks. dryRun lists what would go and change and writes nothing. Returns the keys uploaded and deleted, and
// how many were in the bucket as they are. writer stands in for the bucket.
export async function deploy({ root = process.cwd(), dryRun = false, log = console.log, progress = progressLine, wait, writer: given = null } = {}) {
  const siteFile = path.join(root, 'site.yaml');
  const site = fs.existsSync(siteFile) ? check(Site, yaml.load(fs.readFileSync(siteFile, 'utf8')), 'site.yaml') : {};
  if (!site.pages) throw new Error('site.yaml: add a pages block with the bucket that holds the site, kitap deploy writes dist/ there');
  if (!site.assets) throw new Error('site.yaml: pages needs the assets block, whose endpoint is the account that holds the pages bucket');
  const dist = path.join(root, 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('dist/index.html is missing, kitap build writes the site to deploy');
  const writer = given ?? storeWriter({ endpoint: site.assets.endpoint, bucket: site.pages.bucket }, { command: 'kitap deploy', wait });
  // the build's record: the stories it left unbuilt keep their keys, and a build of named stories leaves no record
  const builtFile = path.join(dist, BUILT_FILE);
  const build = fs.existsSync(builtFile) ? JSON.parse(fs.readFileSync(builtFile, 'utf8')) : null;
  const builtIds = new Set(build?.built.map(b => build.stories.find(([s]) => s === b.story)[1]) ?? []);
  const others = (build?.stories ?? []).map(([, id]) => id).filter(id => !builtIds.has(id));
  const theirs = k => others.some(id => k.startsWith(id + '/'));
  // a dot starts the folder a build writes a story to before it swaps it in, and the files editors and Finder leave
  const files = fs.readdirSync(dist, { recursive: true }).map(f => f.split(path.sep).join('/'))
    .filter(f => !f.split('/').some(s => s.startsWith('.')) && fs.statSync(path.join(dist, f)).isFile() && !theirs(f)).sort();
  const held = new Map((await writer.list()).map(o => [o.key, o.etag]));
  const md5 = f => crypto.createHash('md5').update(fs.readFileSync(path.join(dist, f))).digest('hex');
  // the live record goes last with a record, and without one it goes, so the next build --changed builds every story
  const changed = files.filter(f => held.get(f) !== md5(f)), gone = [...held.keys()].filter(k => !files.includes(k) && !theirs(k) && (!build || k !== RECORD_KEY)).sort();
  const kept = files.length - changed.length, bytes = changed.reduce((n, f) => n + fs.statSync(path.join(dist, f)).size, 0);
  const record = build && { format: RECORD_FORMAT, stories: Object.fromEntries(build.stories.map(([s]) => [s, build.built.find(b => b.story === s) ?? build.live[s]])
    .filter(([, r]) => r).map(([s, { hash, shared, card }]) => [s, { hash, shared, card }])) };
  if (dryRun) {
    for (const f of changed) log(`upload ${f}`);
    for (const k of gone) log(`delete ${k}`);
    if (others.length) log(`keep the files of ${others.join(', ')} as the bucket holds them`);
    log(`would upload ${plural(changed.length, 'file')} (${mb(bytes)}), delete ${gone.length.toLocaleString('en')}, ${kept.toLocaleString('en')} are in the bucket`);
    return { uploaded: changed, deleted: gone, kept, record };
  }
  // a page links its scripts, fonts and glyphs by version, so they go first and a new page finds them in the bucket
  const script = f => /\.(js|css)$/.test(f) || f.startsWith('vendor/');
  const cur = { what: 'dist', n: 0, total: changed.length, bytes: 0 };
  const put = async f => {
    const body = fs.readFileSync(path.join(dist, f));
    await writer.put(f, body, typeOf(f), CACHE);
    cur.n++; cur.bytes += body.length;
    progress({ ...cur, done: false });
  };
  for (const batch of [changed.filter(script), changed.filter(f => !script(f))]) await pool(batch, 8, put);
  progress({ ...cur, done: true });
  await pool(gone, 8, k => writer.delete(k));
  if (record) await writer.put(RECORD_KEY, Buffer.from(JSON.stringify(record)), 'application/json', CACHE);
  log(`uploaded ${plural(changed.length, 'file')} (${mb(bytes)}), deleted ${gone.length.toLocaleString('en')}, ${kept.toLocaleString('en')} were in the bucket${others.length ? `, kept ${others.length} stories as they were` : ''}`);
  return { uploaded: changed, deleted: gone, kept, record };
}
