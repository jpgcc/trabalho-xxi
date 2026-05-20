#!/usr/bin/env node
/* eslint-disable */
// Splices data/ct-em-vigor.json into index.html between marker comments.
// Run after re-scraping:
//   node scripts/fetch-ct-em-vigor.mjs && node scripts/inline-data.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HTML = join(ROOT, 'index.html');
const JSON_PATH = join(ROOT, 'data', 'ct-em-vigor.json');

const BEGIN = '<!-- BEGIN __data-em-vigor -->';
const END = '<!-- END __data-em-vigor -->';

const data = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
const compact = JSON.stringify(data);
const scriptTag = `<script id="__data-em-vigor" type="application/json">${compact}</script>`;
const block = `${BEGIN}\n${scriptTag}\n${END}`;

let html = readFileSync(HTML, 'utf8');
const re = new RegExp(`${BEGIN}[\\s\\S]*?${END}`);
if (re.test(html)) {
  html = html.replace(re, block);
} else {
  // First-time insert: place right after the existing __data script tag.
  const after = '</script>\n<script type="module" src="app.js">';
  if (!html.includes(after)) throw new Error('could not find anchor for first-time insert');
  html = html.replace(after, `</script>\n${block}\n<script type="module" src="app.js">`);
}
writeFileSync(HTML, html);
process.stderr.write(`inlined ${Object.keys(data.articles).length} CT articles into index.html\n`);
