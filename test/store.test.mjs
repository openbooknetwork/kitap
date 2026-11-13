import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStore, storyTree } from '../src/store.mjs';

const URL_ = 'https://store.test/';
const tree = { ...storyTree('rome', [{ dir: 'content/rome/shared/images/forum-a1b2c3', keys: { large: 'images/forum-large.webp' } }]), dir: 'content/rome' };

// checkStore with every request answered by answer(key): a status, or [status, body]
async function check(answer) {
  const real = globalThis.fetch;
  globalThis.fetch = async url => { const [status, body = ''] = [answer(String(url).slice(URL_.length))].flat(); return new Response(body, { status }); };
  try { await checkStore({ url: URL_, trees: [tree], log() {} }); return null; } catch (err) { return err.message; } finally { globalThis.fetch = real; }
}

test('a story the store has no upload of names the key asked for and its status', async () => {
  const msg = await check(() => 404);
  assert.match(msg, /content\/rome: the store holds no upload of this story, https:\/\/store\.test\/meta\/rome\/latest\.json answered HTTP 404, kitap upload --story rome/);
  assert.doesNotMatch(msg, /403/);
});

test('a store that refuses the machine says so once', async () => {
  const msg = await check(() => 403);
  assert.match(msg, /latest\.json answered HTTP 403/);
  assert.match(msg, /https:\/\/store\.test\/ answered HTTP 403 to 2 of 2 requests: it refuses requests from this machine/);
});

test('missing objects come with the status the store gave for them', async () => {
  const stored = JSON.stringify({ dirs: {} });
  const msg = await check(k => k === 'meta/rome/latest.json' ? [200, JSON.stringify({ root: 'old' })] : k === 'meta/rome/old.json' ? [200, stored] : 404);
  assert.match(msg, /the store lacks the images of content\/rome\/shared\/images\/forum-a1b2c3, HTTP 404 for 1 key, first images\/forum-large\.webp, kitap upload/);
});

test('a complete upload passes', async () => {
  assert.equal(await check(k => k === `meta/rome/${tree.root}.json` ? [200, '{}'] : 404), null);
});
