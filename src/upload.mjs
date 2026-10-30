// kitap upload: puts the images and the engine's objects each story links to into the asset store, then the story's
// hash tree, so kitap build --strict finds them with one request.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { storyAssets } from './build.mjs';
import { checkOriginal, contentType, downloadOriginal, sha256Of } from './image.mjs';
import { typeOf } from './routes.mjs';
import { storeReader, storeWriter, missingKeys, missingIn, pool, describeMissing } from './store.mjs';
import { mb, plural, progressLine } from './util.mjs';

const SIZES = { large: 1280, small: 320 };

// The WebP sizes of an original, fitted inside 1280 and 320 px squares. A raster original is never enlarged, an SVG is
// drawn at each size, and an animated GIF or WebP keeps its frames.
export async function webpSizes(bytes, ext) {
  const sharp = (await import('sharp')).default;
  const svg = ext === '.svg', animated = ext === '.gif' || ext === '.webp';
  // lines and lettering of maps and diagrams stay sharp at the higher quality
  const quality = svg || ext === '.png' ? 90 : 80;
  const meta = svg ? await sharp(bytes).metadata() : null;
  const out = {};
  for (const [name, n] of Object.entries(SIZES)) {
    // an SVG is drawn at the density that makes its longer side n pixels, so the size is drawn, not scaled up
    const density = svg ? Math.min(100000, Math.max(1, 72 * n / Math.max(meta.width, meta.height))) : undefined;
    let img = sharp(bytes, { animated, ...(density ? { density } : {}) });
    if (!animated) img = img.rotate(); // upright by the EXIF orientation, which the WebP does not carry
    out[name] = await img.resize(n, n, { fit: 'inside', withoutEnlargement: !svg }).webp({ quality }).toBuffer();
  }
  return out;
}

// The original of an image: the file on this machine, else the copy in the store, else the download from its url.
async function originalOf(im, reader, inStore) {
  const ext = path.extname(im.keys.original);
  let bytes = null, from;
  if (im.file) { bytes = fs.readFileSync(im.file); from = path.join(im.dir, path.basename(im.file)); }
  else if (inStore && (bytes = await reader.get(im.keys.original))) from = `the store's ${im.keys.original}`;
  else if (im.url) { bytes = (await downloadOriginal(im.url)).bytes; from = im.url; }
  else throw new Error(`${im.dir}: the original is not on this machine, in the store or at a url in image.yaml, add it to the folder`);
  if (sha256Of(bytes) !== im.sha256) throw new Error(`${im.dir}: ${from} does not match the sha256 of image.yaml${im.file ? ', kitap rehash writes the new one' : ''}`);
  await checkOriginal(bytes, ext, from);
  return bytes;
}

// Puts the objects of story, else of every story, into the store of site.yaml's assets: the originals and their WebP
// sizes, the engine's objects, and last each story's hash tree with latest.json naming it. dryRun lists what would go
// and writes nothing. Returns the keys uploaded, or with dryRun the keys it would upload.
export async function upload({ root = process.cwd(), story = null, dryRun = false, log = console.log, progress = progressLine, cache = path.join(root, '.cache', 'kitap'), engine = null, wait, ...options } = {}) {
  const { assets, stories, engine: e } = storyAssets({ root, story, log, engine, cache });
  const reader = storeReader(assets.url, { wait }), writer = dryRun ? null : storeWriter(assets, { wait });
  // an upload lists the bucket once, a thousand keys a request, and a dry run asks through the public URL alone
  const held = writer ? new Set((await writer.list()).map(o => o.key)) : null;
  if (held) log(`the store holds ${held.size.toLocaleString('en')} objects`);
  let cur = null;
  const seen = new Set(), done = new Set(), planned = new Set(), present = new Set(), sum = { images: 0, imageBytes: 0, tiles: 0, tileBytes: 0 };
  const put = async (key, body, type, cacheControl) => {
    if (done.has(key)) return 0;
    await writer.put(key, body, type, cacheControl);
    done.add(key);
    cur.n++; cur.bytes += body.length;
    progress({ ...cur, done: false });
    return body.length;
  };
  for (const s of stories) {
    const { missing: list, complete } = held ? missingIn(held, s.tree) : await missingKeys(reader, s.tree, { headAll: true });
    const missing = new Set(list.filter(k => !done.has(k)));
    for (const k of Object.values(s.tree.dirs).flatMap(x => x.keys)) if (!missing.has(k) && !done.has(k)) present.add(k);
    if (complete) { log(`${s.story}: the store holds every object`); continue; }
    const images = s.images.filter(im => Object.values(im.keys).some(k => missing.has(k)) && !seen.has(im.keys.original));
    for (const im of images) seen.add(im.keys.original);
    const objects = Object.values(s.groups).flat().filter(k => missing.has(k));
    if (dryRun) {
      if (missing.size) log(`${s.story}: would upload ${describeMissing(s.tree, [...missing], e.describeObjects)}`);
      for (const im of images) if (!im.file && !im.url && missing.has(im.keys.original)) throw new Error(`${im.dir}: the original is not on this machine, in the store or at a url in image.yaml, add it to the folder`);
      sum.images += images.length; sum.tiles += objects.length;
      for (const k of missing) planned.add(k);
      continue;
    }
    cur = { what: s.story, n: 0, total: missing.size, bytes: 0 };
    // each image fetches its original once, makes the sizes it lacks and puts its objects, eight images at a time
    await pool(images, 8, async im => {
      const original = await originalOf(im, reader, !missing.has(im.keys.original));
      const ext = path.extname(im.keys.original);
      let bytes = missing.has(im.keys.original) ? await put(im.keys.original, original, contentType(ext)) : 0;
      if (missing.has(im.keys.large) || missing.has(im.keys.small)) {
        const sizes = await webpSizes(original, ext);
        for (const name of Object.keys(SIZES)) if (missing.has(im.keys[name])) bytes += await put(im.keys[name], sizes[name], 'image/webp');
      }
      sum.images++; sum.imageBytes += bytes;
    });
    // the engine makes its missing objects into a folder of their own, and each goes up under its key
    if (objects.length) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitap-objects-'));
      try {
        await e.make({ stories: [{ ...s, groups: Object.fromEntries(Object.entries(s.groups).map(([g, keys]) => [g, keys.filter(k => missing.has(k))])) }], cache, out: dir, log, options });
        await pool(objects, 8, async k => { sum.tileBytes += await put(k, fs.readFileSync(path.join(dir, k)), typeOf(k)); sum.tiles++; });
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
    progress({ ...cur, done: true });
    // the tree goes last, once every object it names is in the store, and latest.json names it
    const tree = Buffer.from(JSON.stringify(s.tree));
    await writer.put(`meta/${s.story}/${s.tree.root}.json`, tree, 'application/json');
    await writer.put(`meta/${s.story}/latest.json`, Buffer.from(JSON.stringify({ format: s.tree.format, story: s.story, root: s.tree.root })), 'application/json', 'no-cache');
    log(`${s.story}: uploaded, its tree is meta/${s.story}/${s.tree.root}.json`);
  }
  const inStore = [...present].filter(k => !done.has(k)).length;
  // the engine's objects in its own words, such as "198 elevation tiles", else by count
  const others = [...(dryRun ? planned : done)].filter(k => !k.startsWith('images/') && !k.startsWith('meta/'));
  const described = e.describeObjects ? e.describeObjects(others) : plural(others.length, 'other object');
  log(dryRun ? `would upload ${plural(sum.images, 'image')} and ${described}, ${inStore.toLocaleString('en')} objects are in the store`
    : `uploaded ${plural(sum.images, 'image')} (${mb(sum.imageBytes)}) and ${described} (${mb(sum.tileBytes)}), ${inStore.toLocaleString('en')} were in the store`);
  return [...(dryRun ? planned : done)];
}
