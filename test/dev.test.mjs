// The folders kitap dev watches: all of content/ for every story, one story's folder and content/shared/ for one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { watchDirs } from '../src/dev.mjs';

test('a dev server for one story watches that story and the shared folder, not every story', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kitap-dev-'));
  for (const d of ['content/rome/pages', 'content/group/carthage/pages', 'content/shared/images', 'i18n']) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const s of ['content/rome', 'content/group/carthage']) fs.writeFileSync(path.join(root, s, 'story.yaml'), 'id: x\n');
  const inRoot = opts => watchDirs({ root, ...opts }).filter(d => d.startsWith(root)).map(d => path.relative(root, d));
  assert.deepEqual(inRoot({}), ['content', 'i18n']);
  assert.deepEqual(inRoot({ story: 'rome' }), ['content/rome', 'content/shared', 'i18n']);
  assert.deepEqual(inRoot({ story: 'carthage' }), ['content/group/carthage', 'content/shared', 'i18n'], 'a story inside a group folder');
  assert.deepEqual(inRoot({ story: 'nope' }), ['content', 'i18n'], 'a name no story has falls back to all of content/');
});
