// kitap sources against a stand-in for the web: a Wikipedia article, a PDF, a page of text, a page a script draws, and
// a second run that keeps what is there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { sources } from '../src/index.mjs';

const EXAMPLE = fileURLToPath(new URL('../example/', import.meta.url));
const quiet = () => {};
const LESSON = `<html><head><title>One less</title><script>var a = 1;</script></head><body><h1>One less</h1><p>${'Take one counter away &amp; count again. '.repeat(12)}</p></body></html>`;

function project(lists) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kitap-'));
  fs.cpSync(EXAMPLE, root, { recursive: true });
  for (const [name, urls] of Object.entries(lists)) fs.writeFileSync(path.join(root, 'content/first-story', name), urls.join('\n'));
  return root;
}
function web(calls) {
  return async url => {
    calls.push(url);
    const body = text => ({ ok: true, text: async () => text, arrayBuffer: async () => Buffer.from(text) });
    if (url.includes('title=Old_name')) return body('#REDIRECT [[New name]]');
    if (url.includes('title=New_name')) return body('{{Infobox city|name=New<ref>a</ref>}}\nThe article.');
    if (url.endsWith('.pdf')) return body('%PDF-1.7 bytes');
    if (url.endsWith('/drawn')) return body('<html><body><div id="app"></div><script>draw()</script></body></html>');
    if (url.endsWith('/gone')) return { ok: false, status: 404 };
    return body(LESSON);
  };
}

test('sources saves an article, a PDF and a page per list, reports what failed, and keeps what is there', async () => {
  const root = project({
    'wikipedia.urls': ['# the article', 'https://en.wikipedia.org/wiki/Old_name'],
    'references.urls': ['https://www.example.org/lessons/one-less?a=teacher # the lesson', 'https://example.org/files/guide.pdf', 'https://example.org/drawn', 'https://example.org/gone'],
  });
  const dir = path.join(root, 'content/first-story'), calls = [], lines = [];
  const run = fetch => sources({ root, story: 'first-story', log: l => lines.push(l), fetch, pause: 0, pdftotext: 'no-such-binary' });
  const first = await run(web(calls));
  assert.deepEqual(first.written, ['content/first-story/.references/example.org-lessons-one-less-a-teacher.txt', 'content/first-story/.references/example.org-files-guide.pdf', 'content/first-story/.wikipedia/Old_name.wiki']);
  assert.deepEqual(first.failed, ['https://example.org/drawn', 'https://example.org/gone']);
  assert.match(fs.readFileSync(path.join(dir, '.references/example.org-lessons-one-less-a-teacher.txt'), 'utf8'), /^https:\/\/www\.example\.org\/lessons\/one-less\?a=teacher\n\nOne less\nOne less\nTake one counter away & count again\./);
  assert.equal(fs.readFileSync(path.join(dir, '.wikipedia/Old_name.wiki'), 'utf8'), '{{Infobox city|name=New<ref>a</ref>}}\nThe article.');
  assert.match(fs.readFileSync(path.join(dir, '.wikipedia/Old_name.infobox.txt'), 'utf8'), /\{\{Infobox city\|name=New\}\}/);
  const log = lines.join('\n');
  assert.match(log, /save it from a browser as content\/first-story\/\.references\/example\.org-drawn\.html/);
  assert.match(log, /the site answered 404: save it from a browser as content\/first-story\/\.references\/example\.org-gone\.html or \.pdf/);
  assert.match(log, /brew install poppler/);

  // the drawn page arrives by hand, and the second run asks the web for the missing page alone
  fs.writeFileSync(path.join(dir, '.references/example.org-drawn.html'), LESSON);
  const again = [], second = await run(web(again));
  assert.deepEqual(again, ['https://example.org/gone']);
  assert.equal(second.kept.length, 4);
  assert.ok(fs.existsSync(path.join(dir, '.references/example.org-drawn.txt')));
});

test('sources reads a folder that has no story.yaml yet, and names a folder without a list', async () => {
  const root = project({});
  await assert.rejects(sources({ root, story: 'first-story', log: quiet }), /has no \.urls file: list the URLs one per line in content\/first-story\/references\.urls/);
  await assert.rejects(sources({ root, story: 'no-story', log: quiet }), /"no-story" is not a folder under content/);
  fs.mkdirSync(path.join(root, 'content/planned'));
  fs.writeFileSync(path.join(root, 'content/planned/references.urls'), 'https://example.org/lesson\n');
  const { written } = await sources({ root, story: 'planned', log: quiet, fetch: web([]), pause: 0 });
  assert.deepEqual(written, ['content/planned/.references/example.org-lesson.txt']);
});
