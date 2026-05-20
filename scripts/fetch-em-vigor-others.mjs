#!/usr/bin/env node
/* eslint-disable */
// One-off scraper for the non-CT diplomas referenced in the dataset. Writes
// data/em-vigor-others.json. Run manually:
//   node scripts/fetch-em-vigor-others.mjs
// Requires Node 20+ (built-in fetch + TextDecoder).
//
// Two source flavours:
//   - pgdlisboa.pt — same iso-8859-1 HTML as the CT scraper
//   - diariodarepublica.pt — SPA, fetched via r.jina.ai reader (markdown)
//
// Only articles enumerated in TARGETS are kept, to keep the inlined JSON small.

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'data', 'em-vigor-others.json');

// Diplomas to fetch. `articles` lists the article numbers we want to keep.
// The "L98-2009 art 8.º" entry comes from the Norma Revogatória; the other
// targets come from the Proposta's amendment articles.
const TARGETS = [
  {
    key: 'L107-2009',
    label: 'Lei n.º 107/2009 — Regime processual contraordenações laborais',
    source: 'https://www.pgdlisboa.pt/leis/lei_mostra_articulado.php?nid=1154&tabela=leis',
    flavour: 'pgdlisboa',
    nid: 1154,
    articles: ['35.º'],
  },
  {
    key: 'DL259-2009',
    label: 'Decreto-Lei n.º 259/2009 — Arbitragem obrigatória / necessária',
    source: 'https://www.pgdlisboa.pt/leis/lei_mostra_articulado.php?nid=3026&tabela=leis',
    flavour: 'pgdlisboa',
    nid: 3026,
    articles: ['27.º'],
  },
  {
    key: 'CPT',
    label: 'Código de Processo do Trabalho',
    source: 'https://www.pgdlisboa.pt/leis/lei_mostra_articulado.php?nid=487&tabela=leis',
    flavour: 'pgdlisboa',
    nid: 487,
    // 74.º-B and 161.º-A are aditamentos pela Proposta — não existem no CPT em vigor.
    articles: ['5.º', '33.º', '33.º-B', '34.º', '186.º-M'],
  },
  {
    key: 'L15-2001',
    label: 'Lei n.º 15/2001 — Regime geral das infrações tributárias',
    source: 'https://www.pgdlisboa.pt/leis/lei_mostra_articulado.php?nid=259&tabela=leis',
    flavour: 'pgdlisboa',
    nid: 259,
    articles: ['106.º-A'],
  },
  {
    key: 'DL102-2000',
    label: 'Decreto-Lei n.º 102/2000 — Estatuto da Inspeção-Geral do Trabalho',
    source: 'https://www.pgdlisboa.pt/leis/lei_mostra_articulado.php?nid=660&tabela=leis',
    flavour: 'pgdlisboa',
    nid: 660,
    articles: ['11.º'],
  },
  {
    key: 'L98-2009',
    label: 'Lei n.º 98/2009 — Acidentes de trabalho e doenças profissionais',
    source: 'https://www.pgdlisboa.pt/leis/lei_mostra_articulado.php?nid=1156&tabela=leis',
    flavour: 'pgdlisboa',
    nid: 1156,
    articles: ['8.º'],
  },
  {
    key: 'L4-2019',
    label: 'Lei n.º 4/2019 — Quotas de emprego para pessoas com deficiência',
    source: 'https://diariodarepublica.pt/dr/detalhe/lei/4-2019-117663335',
    flavour: 'dre',
    articles: ['1.º', '5.º'],
  },
  {
    key: 'DL91-2009',
    label: 'Decreto-Lei n.º 91/2009 — Proteção social na parentalidade',
    source: 'https://diariodarepublica.pt/dr/detalhe/decreto-lei/91-2009-603961',
    flavour: 'dre',
    articles: ['12.º', '14.º', '15.º', '24.º', '30.º', '32.º', '41.º', '42.º', '59.º', '71.º-A'],
  },
  {
    key: 'DL187-2007',
    label: 'Decreto-Lei n.º 187/2007 — Pensões de invalidez e velhice',
    source: 'https://diariodarepublica.pt/dr/detalhe/decreto-lei/187-2007-520669',
    flavour: 'dre',
    articles: ['62.º', '79.º'],
  },
  {
    key: 'CRCS',
    label: 'Código dos Regimes Contributivos da Segurança Social',
    source: 'https://diariodarepublica.pt/dr/legislacao-consolidada/lei/1900-34514575',
    flavour: 'dre',
    articles: ['140.º', '140.º-A'],
  },
];

// ---------- pgdlisboa ----------

async function fetchPgdPage(nid, ficha, pagina) {
  const url = `https://www.pgdlisboa.pt/leis/lei_mostra_articulado.php?ficha=${ficha}&artigo_id=&nid=${nid}&pagina=${pagina}&tabela=leis&nversao=&so_miolo=`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  return new TextDecoder('iso-8859-1').decode(buf);
}

const PGD_HEADER_RE = /<td\s+class=txt_base_b_l[^>]*>\s*<font[^>]*>\s*(?:&nbsp;){0,4}Artigo\s+(\d+\.º(?:-[A-Z])?)\s*(?:<br>|<BR>)?\s*([\s\S]*?)<\/td>/g;
const PGD_BODY_RE = /<td\s+valign=top\s+colspan=4\s+class=txt_base_n_l[^>]*>([\s\S]*?)<\/td>/;

function cleanSubtitle(s) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bodyToMarkdown(html) {
  let s = html;
  s = s.replace(/<br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  s = s.replace(/[ \t]+/g, ' ');
  s = s.split('\n').map(l => l.trim()).join('\n');
  s = s.replace(/^(\d+)\s*-\s+/gm, '$1 — ');
  s = s.replace(/(?<!\n)\n(\d+ — )/g, '\n\n$1');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function* splitPgdArticles(pageHTML) {
  const headers = [];
  let m;
  PGD_HEADER_RE.lastIndex = 0;
  while ((m = PGD_HEADER_RE.exec(pageHTML)) !== null) {
    headers.push({ idx: m.index, articleNum: m[1], subtitleRaw: m[2], headerEnd: PGD_HEADER_RE.lastIndex });
  }
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const sliceEnd = i + 1 < headers.length ? headers[i + 1].idx : pageHTML.length;
    const slice = pageHTML.slice(h.headerEnd, sliceEnd);
    const bm = slice.match(PGD_BODY_RE);
    if (!bm) continue;
    yield {
      articleNum: h.articleNum,
      subtitle: cleanSubtitle(h.subtitleRaw),
      body: bodyToMarkdown(bm[1]),
    };
  }
}

async function fetchPgdDiploma(target) {
  const wanted = new Set(target.articles);
  const found = {};
  // Walk pages until we either have everything we want or the page returns
  // no new articles (i.e. we ran off the end).
  for (let pagina = 1; pagina <= 12; pagina++) {
    if (wanted.size === 0) break;
    const ficha = (pagina - 1) * 100 + 1;
    process.stderr.write(`  ${target.key} page ${pagina} (ficha=${ficha})… `);
    let html;
    try {
      html = await fetchPgdPage(target.nid, ficha, pagina);
    } catch (e) {
      process.stderr.write(`error: ${e.message}\n`);
      break;
    }
    let pageCount = 0;
    let kept = 0;
    for (const a of splitPgdArticles(html)) {
      pageCount++;
      if (wanted.has(a.articleNum) && !found[a.articleNum]) {
        found[a.articleNum] = { subtitle: a.subtitle, body: a.body };
        wanted.delete(a.articleNum);
        kept++;
      }
    }
    process.stderr.write(`${pageCount} arts, kept ${kept}\n`);
    if (pageCount === 0) break;
  }
  if (wanted.size > 0) {
    process.stderr.write(`  ${target.key} MISSING: ${[...wanted].join(', ')}\n`);
  }
  return found;
}

// ---------- DRE via jina reader ----------

async function fetchDREMarkdown(url) {
  const proxied = `https://r.jina.ai/${url}`;
  const r = await fetch(proxied);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${proxied}`);
  return await r.text();
}

// In the jina markdown the article header sits on its own line:
//   Artigo N.º
//   Subtitle
//   Body…
// followed by another "Artigo N.º" or EOF.
function* splitDREArticles(md) {
  // Normalize CR/LF and strip the leading title block jina adds.
  const text = md.replace(/\r\n/g, '\n');
  const HEADER_RE = /^Artigo\s+(\d+\.º(?:-[A-Z])?)\s*$/gm;
  const headers = [];
  let m;
  while ((m = HEADER_RE.exec(text)) !== null) {
    headers.push({ idx: m.index, end: HEADER_RE.lastIndex, articleNum: m[1] });
  }
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const next = i + 1 < headers.length ? headers[i + 1].idx : text.length;
    const block = text.slice(h.end, next).replace(/^\n+/, '');
    // First non-blank line is the subtitle; rest is the body.
    const lines = block.split('\n');
    let subtitle = '';
    let bodyStart = 0;
    for (let j = 0; j < lines.length; j++) {
      const ln = lines[j].trim();
      if (ln) { subtitle = ln; bodyStart = j + 1; break; }
    }
    const body = lines.slice(bodyStart).join('\n');
    yield { articleNum: h.articleNum, subtitle, body: cleanupDREBody(body) };
  }
}

function cleanupDREBody(s) {
  let out = s;
  // Strip markdown link wrappers around external references.
  out = out.replace(/\[([^\]]+)\]\([^)]*\s+"[^"]*"\)/g, '$1');
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Trim trailing/leading boilerplate footers ("Versões anteriores", etc.)
  out = out.split(/^Versões? anteriores/m)[0];
  // Trim each line and collapse multi-blank gaps.
  out = out.split('\n').map(l => l.trimEnd()).join('\n');
  out = out.replace(/\n{3,}/g, '\n\n');
  // Normalize paragraph markers: DRE uses "1 -" (ASCII hyphen); the rest of
  // the dataset uses "1 — " (em-dash). Only touch line-leading markers, not
  // body content.
  out = out.replace(/^(\d+)\s*-\s+/gm, '$1 — ');
  return out.trim();
}

async function fetchDREDiploma(target) {
  const wanted = new Set(target.articles);
  const found = {};
  process.stderr.write(`  ${target.key} via jina… `);
  let md;
  try {
    md = await fetchDREMarkdown(target.source);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return found;
  }
  let total = 0;
  for (const a of splitDREArticles(md)) {
    total++;
    if (wanted.has(a.articleNum) && !found[a.articleNum]) {
      found[a.articleNum] = { subtitle: a.subtitle, body: a.body };
      wanted.delete(a.articleNum);
    }
  }
  process.stderr.write(`${total} arts, kept ${Object.keys(found).length}\n`);
  if (wanted.size > 0) {
    process.stderr.write(`  ${target.key} MISSING: ${[...wanted].join(', ')}\n`);
  }
  return found;
}

// ---------- Main ----------

async function main() {
  const scrapedAt = new Date().toISOString().slice(0, 10);
  const out = {};
  for (const target of TARGETS) {
    process.stderr.write(`fetching ${target.key} (${target.flavour})…\n`);
    const articles = target.flavour === 'pgdlisboa'
      ? await fetchPgdDiploma(target)
      : await fetchDREDiploma(target);
    out[target.key] = {
      source: target.source,
      scrapedAt,
      label: target.label,
      articles,
    };
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  process.stderr.write(`wrote ${OUT}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
