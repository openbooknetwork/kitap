// loadCatalogues as an engine calls it, with kitap's own yaml reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadCatalogues } from '../src/index.mjs';

test('loadCatalogues reads each language that has a file, flat or nested, with no loader handed in', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitap-'));
  fs.writeFileSync(path.join(dir, 'en.yaml'), 'counters_more: "more"\nrows:\n  top: "Top row"\n');
  fs.writeFileSync(path.join(dir, 'tr.yaml'), 'counters_more: "daha çok"\n');
  fs.writeFileSync(path.join(dir, 'de.yaml'), '');
  assert.deepEqual(loadCatalogues(dir, ['en', 'tr', 'de', 'fr']), { en: { counters_more: 'more', 'rows.top': 'Top row' }, tr: { counters_more: 'daha çok' }, de: {} });
});
