// kitap image-candidates against a stand-in for the Commons API: what it downloads, what it skips as held, and resume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { imageCandidates } from '../src/index.mjs';

const EXAMPLE = fileURLToPath(new URL('../example/', import.meta.url));
const quiet = () => {};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const HELD = 'https://commons.wikimedia.org/wiki/File%3AHeld.jpg';

// a book with the example story, one image folder holding File:Held.jpg, and a queries file for the story
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kitap-'));
  fs.cpSync(EXAMPLE, root, { recursive: true });
  fs.mkdirSync(path.join(root, 'content/shared/images/held-abc123'), { recursive: true });
  fs.writeFileSync(path.join(root, 'content/shared/images/held-abc123/image.yaml'), yaml.dump({ caption: { en: 'Held' }, source: HELD }));
  fs.writeFileSync(path.join(root, 'queries.yaml'), yaml.dump({ 'first-story': { landing: { queries: ['harbour'] } } }));
  return root;
}
// the search finds two files, one the book holds, and every thumbnail is the same PNG
function commons(calls) {
  return async (url, { headers }) => {
    calls.push({ url, agent: headers['User-Agent'] });
    const u = new URL(url), json = body => ({ ok: true, json: async () => body });
    if (u.searchParams.get('list') === 'search') return json({ query: { search: [{ title: 'File:Harbour.jpg' }, { title: 'File:Held.jpg' }] } });
    if (u.searchParams.get('prop') === 'imageinfo') return json({ query: { pages: Object.fromEntries(u.searchParams.get('titles').split('|').map((t, i) => [i, { title: t,
      imageinfo: [{ thumburl: `https://upload.wikimedia.org/${t.slice(5)}.png`, width: 1, height: 1, extmetadata: { Artist: { value: '<b>A. Painter</b>' }, LicenseShortName: { value: 'CC BY-SA 4.0' } } }] }])) } });
    return { ok: true, arrayBuffer: async () => PNG };
  };
}

test('image-candidates downloads what it finds, lists what the book holds, and skips a page done earlier', async () => {
  const root = project(), calls = [];
  const index = await imageCandidates({ root, story: 'first-story', queries: 'queries.yaml', log: quiet, fetch: commons(calls), pause: 0 });
  const dir = path.join(root, 'content/first-story/.candidates');
  assert.deepEqual(index.landing.map(c => [c.title, c.file, c.held ?? null]), [['Harbour.jpg', '01-Harbour.png', null], ['Held.jpg', null, 'held-abc123']]);
  assert.equal(index.landing[0].author, 'A. Painter');
  assert.ok(fs.existsSync(path.join(dir, 'landing/01-Harbour.png')));
  assert.deepEqual(yaml.load(fs.readFileSync(path.join(dir, 'index.yaml'), 'utf8')), index);
  assert.match(calls[0].agent, /^Example book image-candidates \(/, 'the user agent names the book');
  const again = [];
  await imageCandidates({ root, story: 'first-story', queries: 'queries.yaml', log: quiet, fetch: commons(again), pause: 0 });
  assert.equal(again.length, 0);
});

test('image-candidates names a missing queries file option and an unknown story', async () => {
  const root = project();
  await assert.rejects(imageCandidates({ root, story: 'first-story', log: quiet }), /--queries <file>/);
  await assert.rejects(imageCandidates({ root, story: 'no-story', queries: 'queries.yaml', log: quiet }), /"no-story" is not a story folder/);
});
