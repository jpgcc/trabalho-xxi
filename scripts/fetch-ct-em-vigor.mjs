#!/usr/bin/env node
/* eslint-disable */
// One-off scraper: fetches the current Código do Trabalho from pgdlisboa and writes
// data/ct-em-vigor.json. Run manually whenever the source law changes:
//   node scripts/fetch-ct-em-vigor.mjs
// Requires Node 20+ (built-in fetch + TextDecoder).

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = 'https://www.pgdlisboa.pt/leis/lei_mostra_articulado.php?nid=1047&tabela=leis';
const OUT = join(ROOT, 'data', 'ct-em-vigor.json');

// Pages cover 100 fichas each: ficha=1 / 101 / 201 / … / 601
const PAGES = [
  { ficha: 1,   pagina: 1 },
  { ficha: 101, pagina: 2 },
  { ficha: 201, pagina: 3 },
  { ficha: 301, pagina: 4 },
  { ficha: 401, pagina: 5 },
  { ficha: 501, pagina: 6 },
  { ficha: 601, pagina: 7 },
];

async function fetchPage({ ficha, pagina }) {
  const url = `https://www.pgdlisboa.pt/leis/lei_mostra_articulado.php?ficha=${ficha}&artigo_id=&nid=1047&pagina=${pagina}&tabela=leis&nversao=&so_miolo=`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  return new TextDecoder('iso-8859-1').decode(buf);
}

// Article block on pgdlisboa looks like:
//   <td class=txt_base_b_l><font …>&nbsp;&nbsp;Artigo N.º<br> Subtitle</td>
//   …
//   <td valign=top colspan=4 class=txt_base_n_l>BODY</td>
// We extract (a) the article number, (b) the subtitle, (c) the body — ignoring the
// dropdown <option> entries which use a different markup.
const HEADER_RE = /<td\s+class=txt_base_b_l[^>]*>\s*<font[^>]*>\s*(?:&nbsp;){0,4}Artigo\s+(\d+\.º(?:-[A-Z])?)\s*(?:<br>|<BR>)?\s*([\s\S]*?)<\/td>/g;
const BODY_RE   = /<td\s+valign=top\s+colspan=4\s+class=txt_base_n_l[^>]*>([\s\S]*?)<\/td>/;

function cleanSubtitle(s) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// pgdlisboa bodies are plain text with <BR> separators and "1 - …" / "a) …"
// paragraph markers. Convert to the lightweight Markdown shape the existing
// data uses ("1 — …" with em-dash and blank lines between numbered items).
function bodyToMarkdown(html) {
  let s = html;
  // unify <br> variants → newline
  s = s.replace(/<br\s*\/?\s*>/gi, '\n');
  // drop any other tags
  s = s.replace(/<[^>]+>/g, '');
  // entities
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  // collapse runs of spaces / tabs
  s = s.replace(/[ \t]+/g, ' ');
  // trim each line
  s = s.split('\n').map(l => l.trim()).join('\n');
  // pgdlisboa uses ASCII hyphen for paragraph markers ("1 - …"); the existing
  // dataset uses em-dash ("1 — …"). Normalise just the markers, not body content.
  s = s.replace(/^(\d+)\s*-\s+/gm, '$1 — ');
  // blank-line between top-level numbered paragraphs for readability
  s = s.replace(/(?<!\n)\n(\d+ — )/g, '\n\n$1');
  // collapse 3+ newlines
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function* splitArticles(pageHTML) {
  // We want each header AND its body. Strategy: find every header match, then for
  // each header, search forward for the next BODY_RE occurrence and pair them.
  const headers = [];
  let m;
  HEADER_RE.lastIndex = 0;
  while ((m = HEADER_RE.exec(pageHTML)) !== null) {
    headers.push({ idx: m.index, articleNum: m[1], subtitleRaw: m[2], headerEnd: HEADER_RE.lastIndex });
  }
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const sliceEnd = i + 1 < headers.length ? headers[i + 1].idx : pageHTML.length;
    const slice = pageHTML.slice(h.headerEnd, sliceEnd);
    const bm = slice.match(BODY_RE);
    if (!bm) continue; // dropdown / non-rendered occurrence
    yield {
      articleNum: h.articleNum,
      subtitle: cleanSubtitle(h.subtitleRaw),
      body: bodyToMarkdown(bm[1]),
    };
  }
}

// Find the unique CT articleNum values referenced in index.html so we can
// report coverage gaps.
function ctArticleNumsInDataset() {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const re = /"articleNum":"([^"]+)"[^}]*"diploma":\{"key":"CT"/g;
  const set = new Set();
  let m;
  while ((m = re.exec(html)) !== null) set.add(m[1]);
  return set;
}

async function main() {
  const articles = {};
  let firstCTSeen = false;
  for (const p of PAGES) {
    process.stderr.write(`fetching page ${p.pagina} (ficha=${p.ficha})… `);
    const html = await fetchPage(p);
    let count = 0;
    for (const a of splitArticles(html)) {
      // Skip the 14 articles from the preamble Lei 7/2009 (which precede the
      // Código itself on page 1). The CT annex begins with "Artigo 1.º
      // Fontes específicas" — once we see that, switch on.
      if (!firstCTSeen) {
        if (a.articleNum === '1.º' && /Fontes\s+espec[ií]ficas/i.test(a.subtitle)) {
          firstCTSeen = true;
        } else {
          continue;
        }
      }
      // De-dupe (a later page repeating an earlier article would be a bug)
      if (articles[a.articleNum]) continue;
      articles[a.articleNum] = { subtitle: a.subtitle, body: a.body };
      count++;
    }
    process.stderr.write(`+${count} arts\n`);
  }

  const out = {
    source: SOURCE,
    scrapedAt: new Date().toISOString().slice(0, 10),
    articles,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  process.stderr.write(`wrote ${OUT} (${Object.keys(articles).length} articles)\n`);

  // Coverage check against index.html
  const wanted = ctArticleNumsInDataset();
  const missing = [...wanted].filter(n => !articles[n]).sort();
  if (missing.length === 0) {
    process.stderr.write(`coverage: all ${wanted.size} CT articles referenced in index.html were found.\n`);
  } else {
    process.stderr.write(`coverage: ${wanted.size - missing.length}/${wanted.size} CT articles found. MISSING:\n`);
    for (const n of missing) process.stderr.write(`  - ${n}\n`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
