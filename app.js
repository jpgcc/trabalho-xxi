/* === Reforma Laboral — Comparison app === */

import { marked } from 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js';
import { diffWordsWithSpace } from 'https://cdn.jsdelivr.net/npm/diff@5.2.0/+esm';

// ---------- Data ----------
// Pretty-printed JSON files are fetched at load. The em-vigor side keeps the
// per-source split it scrapes into; we recombine the two files into the same
// shape app.js expects: { CT: {...}, "L107-2009": {...}, … }.
const [DATA, ctEmVigor, othersEmVigor] = await Promise.all([
  fetch('data/proposta.json').then(r => r.json()),
  fetch('data/ct-em-vigor.json').then(r => r.json()),
  fetch('data/em-vigor-others.json').then(r => r.json()),
]);
const IN_FORCE = {
  CT: { source: ctEmVigor.source, scrapedAt: ctEmVigor.scrapedAt, articles: ctEmVigor.articles },
  ...othersEmVigor,
};

// ---------- Left-column source toggle ----------
const LS_KEY = 'reformaLaboral.leftSource';
let leftSource = localStorage.getItem(LS_KEY) === 'em-vigor' ? 'em-vigor' : 'anteprojeto';

// What the left column should actually show for a given row, given the toggle.
// Returns null when the toggle is "em-vigor" but no in-force text is available
// (addition-mode article, diploma not scraped, or article not in the scraped
// subset).
function effectiveLeft(row) {
  if (leftSource === 'anteprojeto') return row.left;
  if (row.kind !== 'article') return row.left;
  if (row.mode === 'addition') return null;
  const dipKey = row.diploma?.key;
  const diploma = dipKey && IN_FORCE[dipKey];
  if (!diploma) return null;
  const num = row.right?.articleNum || row.left?.articleNum;
  if (!num) return null;
  const art = diploma.articles?.[num];
  if (!art) return null;
  return {
    ...(row.left || {}),
    articleNum: num,
    body: art.body,
    subtitle: art.subtitle || row.left?.subtitle || '',
  };
}

// When toggled to em-vigor, the Proposta-only context rows (Exposição de
// motivos, Objeto) have no counterpart in current law — skip them entirely.
function shouldRenderRow(row) {
  if (leftSource !== 'em-vigor') return true;
  if (row.kind === 'preamble') return false;
  if (row.kind === 'objeto') return false;
  return true;
}

function emVigorPlaceholderText(row) {
  if (row.mode === 'addition') return 'artigo aditado pela Proposta — sem texto em vigor';
  const dipKey = row.diploma?.key;
  if (!dipKey || !IN_FORCE[dipKey]) return 'texto em vigor ainda não disponível para este diploma';
  return 'texto em vigor não encontrado';
}

// ---------- Norma Revogatória expansion ----------
// The Proposta's Artigo 14.º (Norma revogatória) bundles ~30 revocations across
// 8 diplomas in a single row. We parse that text once on load and synthesise
// one row per (diploma, article) so revocations are visible alongside the
// modifications and aditamentos that affect the same diploma.

const REVOG_DIPLOMA_PATTERNS = [
  // Test more specific names first to avoid CT-substring trap.
  [/Código de Processo do Trabalho/i, 'CPT'],
  [/Código do Trabalho/i,              'CT'],
  [/Decreto-Lei n\.º 102\/2000/i,      'DL102-2000'],
  [/Decreto-Lei n\.º 187\/2007/i,      'DL187-2007'],
  [/Decreto-Lei n\.º 91\/2009/i,       'DL91-2009'],
  [/Decreto-Lei n\.º 259\/2009/i,      'DL259-2009'],
  [/Lei n\.º 98\/2009/i,               'L98-2009'],
];

// Labels for diplomas not present in the existing dataset.
const REVOG_NEW_DIPLOMA_LABELS = {
  'L98-2009': 'Lei n.º 98/2009 — Acidentes de trabalho e doenças profissionais',
};

function normalizeArtNum(raw) {
  // Tolerant: handles "33.º-B", "501-A.º" (source typo), "33.º", "33".
  const m = String(raw).match(/^(\d+)(?:[.\-]?(?:º)?)?(?:-?([A-Z]))?(?:\.?º)?$/);
  if (!m) return String(raw);
  return m[2] ? `${m[1]}.º-${m[2]}` : `${m[1]}.º`;
}

function cleanRevogScope(s) {
  let t = s;
  t = t.replace(/\*([^*]+)\*/g, '$1');                 // *k)* → k)
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/^[,;]\s*/, '');                       // leading punctuation
  t = t.replace(/^(e)(?:\s+|$)/i, '');                 // leading conjunction
  t = t.replace(/^(o|a|os|as|ao|à)(?:\s+|$)/i, '');    // leading article
  t = t.replace(/\s+(do|da|de)\s*$/i, '');             // trailing connector
  t = t.trim();
  return t || '(integralmente)';
}

// Some entries in the source text omit the "artigo" keyword before a bare
// article-number token (e.g. "o 515.º-A" instead of "o artigo 515.º-A").
// Repair those before scanning so the article-finder regex picks them up.
function repairArticleRefs(text) {
  return text.replace(/(\d+\.º(?:-[A-Z])?|\d+-[A-Z]\.º)/g, (match, _g1, offset, str) => {
    const before = str.slice(Math.max(0, offset - 12), offset);
    if (/artigo\s+$/i.test(before)) return match;             // already an artigo ref
    if (/n\.\s*[º°]?\s*$/i.test(before)) return match;        // "n.º N" — paragraph
    if (/alínea\s*\w?\)?\s*$/i.test(before)) return match;    // "alínea k)" etc
    if (/subalínea\s*\w?\)?\s*$/i.test(before)) return match; // "subalínea iii)"
    return 'artigo ' + match;
  });
}

function extractRevogItems(text) {
  // Returns Array<{ articleNum, scope }>. Each "artigo X.º" reference defines
  // one item; the scope is the cleaned text between the previous match's end
  // and this match's start.
  const items = [];
  const repaired = repairArticleRefs(text);
  const ART_RE = /artigo\s+(\d+(?:\.º(?:-[A-Z])?|-[A-Z]\.º|\.?))/gi;
  let lastEnd = 0;
  let m;
  while ((m = ART_RE.exec(repaired)) !== null) {
    const before = repaired.slice(lastEnd, m.index);
    items.push({
      articleNum: normalizeArtNum(m[1]),
      scope: cleanRevogScope(before),
    });
    lastEnd = m.index + m[0].length;
  }
  return items;
}

function parseRevogatoria(body) {
  // Returns Map<diplomaKey, { items: Map<articleNum, string[]> }>
  const out = new Map();
  // Split on bullet markers "- *a)* "
  const parts = body.split(/(?:^|\n)\s*-\s*\*[a-z]\)\*\s*/i).slice(1);
  for (const raw of parts) {
    // Identify diploma
    let diplomaKey = null;
    let diplomaIdx = -1;
    for (const [re, key] of REVOG_DIPLOMA_PATTERNS) {
      const mm = re.exec(raw);
      if (mm && (diplomaIdx === -1 || mm.index < diplomaIdx)) {
        diplomaKey = key;
        diplomaIdx = mm.index;
      }
    }
    if (!diplomaKey || diplomaIdx < 0) continue;
    // Strip everything from the diploma name onwards (incl. trailing "do "/"da ")
    let head = raw.slice(0, diplomaIdx).replace(/\s+(do|da)\s*$/i, '');
    const items = extractRevogItems(head);
    if (!items.length) continue;
    const bucket = out.get(diplomaKey) || { items: new Map() };
    for (const it of items) {
      const arr = bucket.items.get(it.articleNum) || [];
      arr.push(it.scope);
      bucket.items.set(it.articleNum, arr);
    }
    out.set(diplomaKey, bucket);
  }
  return out;
}

function diplomaLabelFor(key) {
  // Reuse the label already present on an existing row, else fall back to the
  // hard-coded "new diploma" labels.
  const r = DATA.rows.find(r => r.diploma?.key === key);
  if (r?.diploma?.label) return r.diploma.label;
  return REVOG_NEW_DIPLOMA_LABELS[key] || key;
}

function synthesizeRevogRows(key, label, items) {
  const banner = {
    kind: 'group-banner',
    diploma: { key, label, mode: 'revogacao' },
    mode: 'revogacao',
    left: null,
    right: {
      type: 'group-banner',
      propostaArtNum: '14.º',
      title: `Artigo 14.º — Revogação no ${label}`,
      subtitle: `Revogação no ${label}`,
      diploma: { key, label, mode: 'revogacao' },
      mode: 'revogacao',
      side: 'right',
      body: `Revogações operadas pelo artigo 14.º da Proposta no ${label}.`,
    },
  };
  // Sort article rows by numeric article number (then suffix letter)
  const sortedNums = [...items.keys()].sort((a, b) => {
    const pa = a.match(/^(\d+)\.º(?:-([A-Z]))?$/);
    const pb = b.match(/^(\d+)\.º(?:-([A-Z]))?$/);
    if (!pa || !pb) return a.localeCompare(b);
    if (+pa[1] !== +pb[1]) return +pa[1] - +pb[1];
    return (pa[2] || '').localeCompare(pb[2] || '');
  });
  const articleRows = sortedNums.map(num => {
    const scopes = items.get(num);
    const isFull = scopes.length === 1 && scopes[0] === '(integralmente)';
    const body = isFull
      ? '[Revogado pelo art. 14.º da Proposta]'
      : `Revogados pelo art. 14.º da Proposta:\n\n${scopes.map(s => `- ${s}`).join('\n')}`;
    return {
      kind: 'article',
      diploma: { key, label, mode: 'revogacao' },
      mode: 'revogacao',
      _revogScopes: scopes,                              // preserved for dedup merge
      _revogIsFull: isFull,
      left: null,
      right: {
        articleNum: num,
        subtitle: isFull ? 'Revogação' : 'Revogação parcial',
        body,
        diploma: { key, label, mode: 'revogacao' },
      },
    };
  });
  return [banner, ...articleRows];
}

function expandRevogatoria() {
  if (DATA.__revogExpanded) return;
  DATA.__revogExpanded = true;

  const revRow = DATA.rows.find(r => r.kind === 'revogatoria');
  if (!revRow || !revRow.right?.body) return;

  const parsed = parseRevogatoria(revRow.right.body);
  if (parsed.size === 0) return;

  // Last index in DATA.rows where each diploma already appears.
  const lastIdxByDiploma = new Map();
  DATA.rows.forEach((r, i) => {
    if (r.diploma?.key) lastIdxByDiploma.set(r.diploma.key, i);
  });
  // Diplomas not yet in the dataset go just before the revogatoria/aplicacao tail.
  const tailIdx = DATA.rows.findIndex(r => r.kind === 'revogatoria');

  const inserts = [];
  for (const [key, { items }] of parsed) {
    const label = diplomaLabelFor(key);
    const rows = synthesizeRevogRows(key, label, items);
    const at = lastIdxByDiploma.has(key) ? lastIdxByDiploma.get(key) + 1 : tailIdx;
    inserts.push({ at, rows });
  }
  // Splice in reverse order so earlier inserts don't shift later ones.
  inserts.sort((a, b) => b.at - a.at);
  for (const ins of inserts) DATA.rows.splice(ins.at, 0, ...ins.rows);
}

expandRevogatoria();

// ---------- Per-diploma merge ----------
// After expansion, each diploma can have up to three sub-sections (Alteração,
// Aditamento, Revogação). Collapse them into a single section per diploma,
// with article rows sorted by numeric article number. The merged banner shows
// aggregated counts (alterados / aditados / revogados).

function articleNumSortKey(num) {
  const m = String(num || '').match(/^(\d+)\.º(?:-([A-Z]))?$/);
  if (!m) return [Number.MAX_SAFE_INTEGER, num || ''];
  return [+m[1], m[2] || ''];
}

function compareArticleNums(a, b) {
  const [ai, as] = articleNumSortKey(a);
  const [bi, bs] = articleNumSortKey(b);
  if (ai !== bi) return ai - bi;
  return as.localeCompare(bs);
}

function makeMergedBanner(key, label) {
  return {
    kind: 'group-banner',
    diploma: { key, label },
    mode: 'merged',
    left: null,
    right: {
      type: 'group-banner',
      title: label,
      subtitle: label,
      diploma: { key, label },
      side: 'right',
      body: '',
    },
  };
}

function mergeDiplomaSections() {
  if (DATA.__merged) return;
  DATA.__merged = true;

  const diplomaOrder = [];
  const seen = new Set();
  const diplomaInfo = new Map(); // key → { label, articles: row[] }
  const headRows = []; // preamble, objeto
  const tailRows = []; // revogatoria (hidden), aplicacao
  const other   = []; // anything else (defensive)

  for (const r of DATA.rows) {
    if (r.kind === 'preamble' || r.kind === 'objeto') { headRows.push(r); continue; }
    if (r.kind === 'revogatoria' || r.kind === 'aplicacao') { tailRows.push(r); continue; }
    if (r.diploma?.key) {
      const k = r.diploma.key;
      if (!seen.has(k)) {
        seen.add(k);
        diplomaOrder.push(k);
        diplomaInfo.set(k, { label: r.diploma.label, articles: [] });
      }
      if (r.kind === 'article') diplomaInfo.get(k).articles.push(r);
      // group-banner rows are dropped; we synthesise one merged banner per diploma
      continue;
    }
    other.push(r);
  }

  // Dedup: a synthesised revogação row for (diploma, article) is redundant
  // when a non-revogação row already exists for that same article — the
  // existing modification/addition row already encodes the revocation (either
  // as a left-only row or via inline [Revogado] markers in its body). Drop
  // the synthesised row and attach its scope info to the keeper as metadata
  // so the renderer can surface the Art. 14.º attribution.
  for (const [, info] of diplomaInfo) {
    const byNum = new Map();
    for (const r of info.articles) {
      const num = r.right?.articleNum || r.left?.articleNum;
      if (!num) continue;
      if (!byNum.has(num)) byNum.set(num, []);
      byNum.get(num).push(r);
    }
    const toDrop = new Set();
    for (const [, rows] of byNum) {
      if (rows.length < 2) continue;
      const revog = rows.find(r => r.mode === 'revogacao');
      const others = rows.filter(r => r.mode !== 'revogacao');
      if (!revog || !others.length) continue;
      const keeper = others[0];
      keeper._revogScopes = revog._revogScopes || null;
      keeper._revogIsFull = revog._revogIsFull || false;
      toDrop.add(revog);
    }
    info.articles = info.articles.filter(r => !toDrop.has(r));

    info.articles.sort((a, b) => compareArticleNums(
      a.right?.articleNum || a.left?.articleNum,
      b.right?.articleNum || b.left?.articleNum,
    ));
  }

  const newRows = [...headRows];
  for (const k of diplomaOrder) {
    const info = diplomaInfo.get(k);
    if (!info.articles.length) continue;
    newRows.push(makeMergedBanner(k, info.label));
    newRows.push(...info.articles);
  }
  newRows.push(...tailRows, ...other);
  DATA.rows = newRows;
}

mergeDiplomaSections();

// ---------- Helpers ----------
function normalizeEllipsis(s) {
  if (!s) return '';
  return s
    .replace(/\[\.\.\.\]|\[···\]|\[…\]/g, '[…]');
}

function bodyForDiff(s) {
  return normalizeEllipsis(s || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeHTML(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Configure marked to be minimal
marked.use({
  gfm: true,
  breaks: false,
  pedantic: false,
});

function renderMarkdown(src) {
  if (!src || !src.trim()) return '';
  return marked.parse(src);
}

// Decorate special markers: [Revogado], [Revogada], [Revogados]
function decorateBody(html) {
  // [Revogado] etc.
  html = html.replace(/\[(?:<em>)?(Revogad[oa]s?)(?:<\/em>)?\]/g, '<span class="revoked">[$1]</span>');
  // Mark ellipsis placeholders subtly
  html = html.replace(/\[…\]/g, '<span class="ellipsis-mark">[…]</span>');
  return html;
}

// ---------- Ellipsis alignment for diff ----------
// In the dataset, "[…]" means "this part is unchanged from the other side"
// (a placeholder, not literal content). Naive word-diff treats it as a token
// and ends up marking all the corresponding real text on the other side as
// deleted. Before diffing we (1) normalise the sub-item bullet style on both
// sides to the markdown-list form ("- *X)* …"), then (2) substitute every
// "[…]"-only paragraph and sub-item on the *right* with the matching content
// from the *left*. The diff then sees mostly-identical text plus only the
// genuine changes.

function normalizeBullets(body) {
  let s = body;
  // After ":" or ";" (across any whitespace, including newlines): pull
  // sub-items onto their own line in markdown-list form.
  s = s.replace(/([:;])\s*(?:-\s*)?\*?([a-z])\)\*?[ \t]+/g, '$1\n- *$2)* ');
  // Line-start sub-items that are bare ("a) text") or already-dashed without
  // italics ("- a) text") → canonical "- *X)* text".
  s = s.replace(/^[ \t]*-?[ \t]*\*?([a-z])\)\*?[ \t]+/gm, '- *$1)* ');
  // Some proposta bodies bunch consecutive numbered paragraphs onto adjacent
  // lines ("1 — […].\n2 — […].\n3 — […]:"). Force a blank line before each
  // "N — " so parseParagraph sees one paragraph per number — otherwise the
  // whole run becomes a single paragraph with num=1 and the ellipsis
  // alignment skips it.
  s = s.replace(/(?<!\n)\n(\d+\s*—\s)/g, '\n\n$1');
  // Collapse runs of blank lines.
  s = s.replace(/\n{3,}/g, '\n\n');
  return s;
}

// True if the string (after trimming) is just "[…]" — optionally followed
// by punctuation like ".", ":" or ";".
function isEllipsisOnly(s) {
  return /^\s*\[…\][.:;]?\s*$/.test(s);
}

// Pull the leading "[…]" placeholder off a string, preserving any trailing
// punctuation. Returns null if the string doesn't start with the placeholder.
function stripLeadingEllipsis(s) {
  const m = s.match(/^\s*\[…\]([.:;]?)\s*([\s\S]*)$/);
  return m ? { punct: m[1], rest: m[2] } : null;
}

function parseParagraph(p) {
  // Returns { num, intro, subItems, raw }. `num` is null for non-numbered
  // paragraphs (preamble / dangling ellipsis). Sub-items are the markdown
  // bullets produced by normalizeBullets.
  const headerMatch = p.match(/^(\d+)\s*—\s*([\s\S]*)$/);
  if (!headerMatch) return { num: null, intro: p.trim(), subItems: [], raw: p };
  const num = headerMatch[1];
  const rest = headerMatch[2];
  const subStart = rest.search(/(?:^|\n)- \*[a-z]\)\*/);
  let intro, subSegment;
  if (subStart >= 0) {
    intro = rest.slice(0, subStart).trim();
    subSegment = rest.slice(subStart).trim();
  } else {
    intro = rest.trim();
    subSegment = '';
  }
  const subItems = [];
  if (subSegment) {
    const RE = /^- \*([a-z])\)\*[ \t]*([\s\S]*?)(?=\n- \*[a-z]\)\*|$)/gm;
    let mm;
    while ((mm = RE.exec(subSegment)) !== null) {
      subItems.push({ letter: mm[1], content: mm[2].trim() });
    }
  }
  return { num, intro, subItems, raw: p };
}

function reassembleParagraph(p) {
  if (p.num == null) return p.intro;
  const head = `${p.num} — ${p.intro}`;
  if (!p.subItems.length) return head;
  const list = p.subItems.map(s => `- *${s.letter})* ${s.content}`).join('\n');
  return `${head}\n${list}`;
}

function expandEllipsisOneWay(target, source) {
  const srcByNum = new Map();
  for (const sp of source.split(/\n{2,}/).map(parseParagraph)) {
    if (sp.num != null) srcByNum.set(sp.num, sp);
  }
  return target.split(/\n{2,}/).map(parseParagraph).map(tp => {
    if (tp.num == null) return tp.raw;                  // preamble / orphan
    const sp = srcByNum.get(tp.num);
    if (!sp) return tp.raw;

    // If the whole paragraph is just "[…]" with no sub-items, the placeholder
    // stands for both the intro AND any sub-items the source has — replace
    // the paragraph wholesale.
    if (isEllipsisOnly(tp.intro) && tp.subItems.length === 0) {
      tp.intro = sp.intro;
      tp.subItems = sp.subItems.map(s => ({ ...s }));
      return reassembleParagraph(tp);
    }

    // Otherwise: substitute intro and/or individual sub-items selectively.
    if (isEllipsisOnly(tp.intro)) {
      const stripped = stripLeadingEllipsis(tp.intro);
      const punct = stripped ? stripped.punct : '';
      tp.intro = sp.intro;
      if (punct && !/[.:;]$/.test(tp.intro)) tp.intro += punct;
    }
    for (const it of tp.subItems) {
      if (isEllipsisOnly(it.content)) {
        const srcIt = sp.subItems.find(s => s.letter === it.letter);
        if (srcIt) {
          const stripped = stripLeadingEllipsis(it.content);
          const punct = stripped ? stripped.punct : '';
          let src = srcIt.content;
          if (punct && !/[.:;]$/.test(src)) src += punct;
          it.content = src;
        }
      }
    }
    return reassembleParagraph(tp);
  }).join('\n\n');
}

function expandEllipsisAlignment(leftBody, rightBody) {
  const leftN  = normalizeBullets(leftBody);
  const rightN = normalizeBullets(rightBody);
  // Right is the main target — most ellipses live there. Also handle the
  // less-common reverse case so a "[…]" on the left gets substituted from
  // the right where available.
  const right = expandEllipsisOneWay(rightN, leftN);
  const left  = expandEllipsisOneWay(leftN,  rightN);
  return { left, right };
}

// Word-level diff between two MD bodies — returns {leftHTML, rightHTML} of the BODY only.
// We diff the markdown text directly and re-render. Diff tokens are wrapped with
// invisible sentinels so we can map them onto rendered HTML afterward — simpler approach:
// run diffWordsWithSpace, then synthesize a left markdown string (kept+removed) and a
// right markdown string (kept+added), render each via marked, wrap added/removed runs
// with <ins>/<del>.
function diffBodies(leftBody, rightBody) {
  let A = bodyForDiff(leftBody);
  let B = bodyForDiff(rightBody);
  if (!A && !B) return { left: '', right: '' };
  if (!A) return { left: '', right: decorateBody(renderMarkdown(B)) };
  if (!B) return { left: decorateBody(renderMarkdown(A)), right: '' };

  // Pre-process: normalise bullet style on both sides and substitute "[…]"
  // placeholders with the corresponding content from the other side. This
  // prevents the word-diff from flagging unchanged-by-elision passages.
  const aligned = expandEllipsisAlignment(A, B);
  A = aligned.left;
  B = aligned.right;

  const parts = diffWordsWithSpace(A, B, { ignoreCase: false });

  // To do markdown-aware diff display we need to render the FULL body then
  // run a second-pass diff on the rendered HTML *text*. Easier: render plain
  // text diff and skip markdown for diff cells — but that loses formatting.
  // Compromise: render markdown, then run diffWords on the *innerText*, then
  // walk the DOM and re-tag matching ranges. We'll do this via a token-mapping
  // approach below.

  // Simpler approach used here:
  //  1) Render full markdown of each side.
  //  2) From diff parts compute the set of added/removed plaintext words
  //     (only those longer than X) — and wrap matching word occurrences in
  //     the rendered HTML.
  // This is approximate but readable. For exact diff we'd need a much
  // heavier tool.

  // -- Better approach: build two synthetic text streams that we render --
  // We rebuild the markdown for each side from diff parts; portions exclusive
  // to one side are wrapped in unique markers \uE000..\uE001 (ins) or
  // \uE002..\uE003 (del). After marked.parse(), we replace those markers
  // with <ins>/</ins> or <del>/</del>.

  const INS_OPEN = '\uE000', INS_CLOSE = '\uE001';
  const DEL_OPEN = '\uE002', DEL_CLOSE = '\uE003';

  let leftMD = '';
  let rightMD = '';

  for (const p of parts) {
    if (p.added) {
      rightMD += INS_OPEN + p.value + INS_CLOSE;
    } else if (p.removed) {
      leftMD += DEL_OPEN + p.value + DEL_CLOSE;
    } else {
      leftMD += p.value;
      rightMD += p.value;
    }
  }

  function finalize(md) {
    let html = renderMarkdown(md);
    // Replace markers with tags. They may straddle HTML boundaries, but
    // they are private-use chars so safe to replace globally.
    html = html
      .replace(new RegExp(INS_OPEN, 'g'), '<ins>')
      .replace(new RegExp(INS_CLOSE, 'g'), '</ins>')
      .replace(new RegExp(DEL_OPEN, 'g'), '<del>')
      .replace(new RegExp(DEL_CLOSE, 'g'), '</del>');
    // Clean up empty tags caused by whitespace-only diff fragments
    html = html.replace(/<(ins|del)>(\s*)<\/\1>/g, '$2');
    // Merge adjacent same-type tags
    html = html.replace(/<\/ins>(\s*)<ins>/g, '$1');
    html = html.replace(/<\/del>(\s*)<del>/g, '$1');
    return decorateBody(html);
  }

  return { left: finalize(leftMD), right: finalize(rightMD) };
}

// Aggressive normalization used only for identical/changed classification.
// Strips ellipsis noise (variant forms, trailing periods, leading preamble
// ellipsis, and numbered items whose entire content is an ellipsis placeholder)
// and collapses all whitespace so formatting-only differences don't produce
// false "changed" status.
function bodyForStatus(s) {
  return normalizeEllipsis(s || '')
    .replace(/\[…\]\./g, '[…]')
    .replace(/^\[…\]\s*\n+/m, '')
    .replace(/\n\d+\s*—\s*\[…\]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
}

// ---------- Status classification ----------
function articleStatus(left, right) {
  if (left && right) {
    const a = bodyForStatus(left.body);
    const b = bodyForStatus(right.body);
    if (a === b) return 'identical';
    return 'changed';
  }
  if (left && !right) return 'left-only';
  if (right && !left) return 'right-only';
  return 'empty';
}

function statusLabel(status, mode) {
  if (status === 'identical') return { cls: 'igual', text: 'Igual' };
  if (status === 'changed') return { cls: 'alteracao', text: 'Alterado' };
  if (status === 'left-only') return { cls: 'removido', text: 'Removido' };
  if (status === 'right-only') return { cls: mode === 'addition' ? 'novo' : 'aditamento', text: mode === 'addition' ? 'Aditado' : 'Aditado' };
  return { cls: 'igual', text: '—' };
}

// ---------- Rendering ----------
const compareEl = document.getElementById('compare');
const gridEl = document.getElementById('grid');
const tocEl = document.getElementById('toc');

function articleHeader(item, side) {
  if (!item) return '';
  const num = item.articleNum || item.propostaArtNum || '';
  const subtitle = item.subtitle || '';
  const diplomaLabel = item.diploma ? item.diploma.key : '';
  return `
    <div class="cell-header">
      <span class="cell-art-num">Artigo ${num}</span>
      <span class="cell-art-title">${escapeHTML(subtitle)}</span>
      ${diplomaLabel ? `<span class="cell-diploma">${diplomaLabel}</span>` : ''}
    </div>`;
}

function renderRowArticle(row, idx) {
  const left = effectiveLeft(row);
  const status = articleStatus(left, row.right);
  const lbl = statusLabel(status, row.mode);
  const ariaId = `r-${idx}`;

  let leftHTML = '', rightHTML = '';
  if (left && row.right) {
    const d = diffBodies(left.body, row.right.body);
    leftHTML = d.left;
    rightHTML = d.right;
  } else if (left) {
    leftHTML = decorateBody(renderMarkdown(bodyForDiff(left.body)));
  } else if (row.right) {
    rightHTML = decorateBody(renderMarkdown(bodyForDiff(row.right.body)));
  }

  const classes = `row kind-article is-${status === 'identical' ? 'identical' : status === 'changed' ? 'changed' : status === 'left-only' ? 'leftonly' : 'rightonly'} ${left && row.right ? 'is-both' : ''} status-${status}`;

  let leftCell;
  if (left) {
    leftCell = `<div class="cell left">${articleHeader(left, 'left')}<div class="cell-body">${leftHTML}</div></div>`;
  } else if (leftSource === 'em-vigor' && row.kind === 'article') {
    leftCell = `<div class="cell left empty placeholder-em-vigor">${emVigorPlaceholderText(row)}</div>`;
  } else if (row.mode === 'revogacao') {
    leftCell = `<div class="cell left empty placeholder-revogacao">revogação não enumerada no Anteprojeto</div>`;
  } else {
    leftCell = `<div class="cell left empty">sem correspondência no Anteprojeto</div>`;
  }

  // Inline Art. 14.º revogação attribution. The synthesised revogação row was
  // dropped during merge; its scope info lives on `row._revogScopes`. Pure
  // revogação rows (mode === 'revogacao') already carry the citation in their
  // body, so don't double-render the note there.
  let revogNote = '';
  if (row._revogScopes && row._revogScopes.length && row.mode !== 'revogacao') {
    const inner = row._revogIsFull
      ? 'integralmente revogado'
      : row._revogScopes.map(s => escapeHTML(s)).join('; ');
    revogNote = `<div class="cell-revog-note"><b>Revogado pelo art. 14.º da Proposta:</b> ${inner}</div>`;
  }

  const rightCell = row.right
    ? `<div class="cell right">${articleHeader(row.right, 'right')}${revogNote}<div class="cell-body">${rightHTML}</div></div>`
    : `<div class="cell right empty">${revogNote || 'sem correspondência na Proposta de Lei'}</div>`;

  const dipl = row.diploma?.key || 'NONE';
  return `<div class="${classes}" id="${ariaId}" data-diploma="${dipl}" data-status="${status}" data-mode="${row.mode || ''}">${leftCell}${rightCell}</div>`;
}

function renderRowToplevel(row, kind, idx) {
  const status = articleStatus(row.left, row.right);
  const ariaId = `r-${idx}`;
  let leftHTML = '', rightHTML = '';
  if (row.left && row.right) {
    const d = diffBodies(row.left.body, row.right.body);
    leftHTML = d.left; rightHTML = d.right;
  } else if (row.left) {
    leftHTML = decorateBody(renderMarkdown(bodyForDiff(row.left.body)));
  } else if (row.right) {
    rightHTML = decorateBody(renderMarkdown(bodyForDiff(row.right.body)));
  }

  function header(it) {
    if (!it) return '';
    const num = it.propostaArtNum || it.articleNum || '';
    return `<div class="cell-header"><span class="cell-art-num">Artigo ${num}</span><span class="cell-art-title">${escapeHTML(it.subtitle || it.title || '')}</span></div>`;
  }
  const leftCell = row.left ? `<div class="cell left">${header(row.left)}<div class="cell-body">${leftHTML}</div></div>` : `<div class="cell left empty">sem correspondência</div>`;
  const rightCell = row.right ? `<div class="cell right">${header(row.right)}<div class="cell-body">${rightHTML}</div></div>` : `<div class="cell right empty">sem correspondência</div>`;
  return `<div class="row kind-toplevel kind-${kind} ${row.left && row.right ? 'is-both' : ''} is-${status}" id="${ariaId}" data-status="${status}">${leftCell}${rightCell}</div>`;
}

function renderRowPreamble(row, idx) {
  const ariaId = `r-${idx}`;
  let leftHTML = '', rightHTML = '';
  if (row.left && row.right) {
    const d = diffBodies(row.left.body, row.right.body);
    leftHTML = d.left; rightHTML = d.right;
  } else if (row.left) { leftHTML = renderMarkdown(row.left.body); }
    else if (row.right) { rightHTML = renderMarkdown(row.right.body); }

  const header = (it, kicker) => `<div class="cell-header"><span class="cell-art-num">${kicker}</span><span class="cell-art-title">Exposição de Motivos</span></div>`;
  const leftCell = row.left ? `<div class="cell left">${header(row.left, 'Preâmbulo')}<div class="cell-body">${leftHTML}</div></div>` : `<div class="cell left empty">—</div>`;
  const rightCell = row.right ? `<div class="cell right">${header(row.right, 'Preâmbulo')}<div class="cell-body">${rightHTML}</div></div>` : `<div class="cell right empty">—</div>`;
  return `<div class="row kind-toplevel kind-preamble is-both" id="${ariaId}" data-status="changed">${leftCell}${rightCell}</div>`;
}

function diplomaArticleStats(rows, dKey, mode) {
  // When mode is 'merged' (or undefined), count across ALL modes for this
  // diploma. Otherwise filter by the given mode.
  let total = 0, changed = 0, added = 0, removed = 0, revoked = 0;
  rows.forEach(r => {
    if (r.kind !== 'article') return;
    if (r.diploma?.key !== dKey) return;
    if (mode && mode !== 'merged' && r.mode !== mode) return;
    // Revogação rows: counted as revoked regardless of diff status.
    if (r.mode === 'revogacao') {
      total++;
      revoked++;
      return;
    }
    const s = articleStatus(effectiveLeft(r), r.right);
    if (s === 'identical') return;
    total++;
    if (s === 'changed') changed++;
    else if (s === 'right-only') added++;
    else if (s === 'left-only') removed++;
  });
  return { total, changed, added, removed, revoked };
}

function renderSectionBanner(row, idx) {
  const d = row.diploma;
  const mode = row.mode || 'merged';
  const stats = diplomaArticleStats(DATA.rows, d.key, mode);
  const isMerged = mode === 'merged';

  const kicker = isMerged ? d.key
              : mode === 'addition' ? 'Aditamento'
              : mode === 'revogacao' ? 'Revogação'
              : 'Alteração';
  const dotColor = isMerged ? 'var(--accent-right)'
              : mode === 'addition' ? 'var(--add-rule)'
              : mode === 'revogacao' ? 'var(--del-rule)'
              : 'var(--accent-right)';

  let refLine;
  if (isMerged) {
    refLine = kicker;
  } else {
    const leftArt = row.left ? `Art. ${row.left.propostaArtNum}` : '—';
    const rightArt = row.right ? `Art. ${row.right.propostaArtNum}` : '—';
    refLine = mode === 'revogacao'
      ? `${kicker} · Proposta ${rightArt}`
      : `${kicker} · Anteprojeto ${leftArt} · Proposta ${rightArt}`;
  }

  return `
    <div class="row kind-section is-section ${stats.total === 0 ? 'is-empty-section' : ''}" id="r-${idx}" data-diploma="${d.key}" data-mode="${mode}">
      <div class="section-banner">
        <div class="section-banner-kicker"><span class="section-banner-dot" style="background:${dotColor}"></span>${refLine}</div>
        <div class="section-banner-title">${escapeHTML(d.label)}</div>
        <div class="section-banner-stats">
          <span><b>${stats.total}</b> artigo${stats.total === 1 ? '' : 's'}</span>
          ${stats.changed ? `<span><span class="pip" style="background:#B8651E"></span><b>${stats.changed}</b> alterado${stats.changed === 1 ? '' : 's'}</span>` : ''}
          ${stats.added ? `<span><span class="pip" style="background:var(--add-rule)"></span><b>${stats.added}</b> aditado${stats.added === 1 ? '' : 's'}</span>` : ''}
          ${stats.removed ? `<span><span class="pip" style="background:var(--del-rule)"></span><b>${stats.removed}</b> só no anteprojeto</span>` : ''}
          ${stats.revoked ? `<span><span class="pip" style="background:var(--del-rule)"></span><b>${stats.revoked}</b> revogado${stats.revoked === 1 ? '' : 's'}</span>` : ''}
        </div>
      </div>
    </div>`;
}

// ---------- Build ----------
function build() {
  let html = '';
  DATA.rows.forEach((row, idx) => {
    if (!shouldRenderRow(row)) return;
    if (row.kind === 'preamble') html += renderRowPreamble(row, idx);
    else if (row.kind === 'objeto') html += renderRowToplevel(row, 'objeto', idx);
    else if (row.kind === 'group-banner') html += renderSectionBanner(row, idx);
    else if (row.kind === 'article') {
      html += renderRowArticle(row, idx);
    }
    // The bundled revogatoria row has been expanded per-diploma — skip it.
    else if (row.kind === 'revogatoria') { /* hidden */ }
    else if (row.kind === 'aplicacao') html += renderRowToplevel(row, 'aplicacao', idx);
  });
  gridEl.innerHTML = html;
}

function buildTOC() {
  let html = '';

  // Collapse All / Expand All controls
  html += `<div class="toc-controls">
    <button class="toc-ctrl-btn" id="toc-collapse-all">Recolher tudo</button>
    <button class="toc-ctrl-btn" id="toc-expand-all">Expandir tudo</button>
  </div>`;

  // Top: preamble + objeto (hidden in em-vigor mode — no current-law counterpart)
  if (leftSource !== 'em-vigor') {
    html += `<div class="toc-section">
      <div class="toc-section-head" data-target="r-0"><span class="toc-section-dot"></span>Preâmbulo</div>
    </div>`;
    html += `<div class="toc-section">
      <div class="toc-section-head" data-target="r-1"><span class="toc-section-dot"></span>Objeto</div>
    </div>`;
  }

  // For each group banner (one per diploma after merging), list its articles
  DATA.rows.forEach((row, idx) => {
    if (row.kind !== 'group-banner') return;
    const isMerged = row.mode === 'merged' || !row.mode;
    const stats = diplomaArticleStats(DATA.rows, row.diploma.key, row.mode);
    const dotColor = isMerged ? 'var(--accent-right)'
                  : row.mode === 'addition' ? 'var(--add-rule)'
                  : row.mode === 'revogacao' ? 'var(--del-rule)'
                  : 'var(--accent-right)';
    // Use the diploma name (truncated before " — " subtitle) rather than the
    // short key so the TOC reads "Código do Trabalho" instead of "CT".
    const shortName = (row.diploma.label || row.diploma.key).split(' — ')[0];
    const heading = isMerged
      ? shortName
      : `${shortName} · ${row.mode === 'addition' ? 'Aditamento' : row.mode === 'revogacao' ? 'Revogação' : 'Alteração'}`;
    html += `<div class="toc-section toc-collapsible">
      <div class="toc-section-head toc-section-toggle" data-target="r-${idx}">
        <span class="toc-section-dot" style="background:${dotColor}"></span>
        ${heading}
        <span class="toc-section-count">${stats.total}</span>
        <span class="toc-chevron" aria-hidden="true">▾</span>
      </div>
      <div class="toc-items">`;
    DATA.rows.forEach((r2, i2) => {
      if (r2.kind !== 'article') return;
      if (r2.diploma?.key !== row.diploma.key) return;
      if (!isMerged && r2.mode !== row.mode) return;
      const r2Left = effectiveLeft(r2);
      const status = articleStatus(r2Left, r2.right);
      const sample = r2.right || r2Left;
      const sub = r2.right?.subtitle || r2Left?.subtitle || '';
      const num = sample?.articleNum || '';
      let tag = '';
      if (r2.mode === 'revogacao') tag = '<span class="toc-tag removed">−</span>';
      else if (status === 'changed') tag = '<span class="toc-tag changed">±</span>';
      else if (status === 'right-only') tag = '<span class="toc-tag added">+</span>';
      else if (status === 'left-only') tag = '<span class="toc-tag removed">−</span>';
      html += `<div class="toc-item" data-target="r-${i2}" data-status="${status}">
        <span class="toc-num">${escapeHTML(num)}</span>
        <span class="toc-label">${escapeHTML(sub)}</span>
        ${tag}
      </div>`;
    });
    html += `</div></div>`;
  });

  // Final — the bundled revogatoria row is hidden; per-diploma "Revogação"
  // sub-sections cover it.
  const aplIdx = DATA.rows.findIndex(r => r.kind === 'aplicacao');
  if (aplIdx >= 0) html += `<div class="toc-section"><div class="toc-section-head" data-target="r-${aplIdx}"><span class="toc-section-dot"></span>Aplicação no tempo</div></div>`;

  tocEl.innerHTML = html;

  // Collapse/expand toggle on diploma sections — chevron toggles, rest scrolls
  tocEl.addEventListener('click', e => {
    if (e.target.closest('.toc-chevron')) {
      const section = e.target.closest('.toc-collapsible');
      if (section) {
        const isCollapsed = section.classList.toggle('is-collapsed');
        section.querySelector('.toc-chevron').textContent = isCollapsed ? '▸' : '▾';
        return;
      }
    }

    const t = e.target.closest('[data-target]');
    if (!t) return;
    const el = document.getElementById(t.dataset.target);
    if (el) {
      const y = el.getBoundingClientRect().top + window.scrollY - 130;
      window.scrollTo({ top: y, behavior: 'smooth' });
    }
  });

  // Collapse All / Expand All
  document.getElementById('toc-collapse-all').addEventListener('click', () => {
    tocEl.querySelectorAll('.toc-collapsible').forEach(sec => {
      sec.classList.add('is-collapsed');
      sec.querySelector('.toc-chevron').textContent = '▸';
    });
  });
  document.getElementById('toc-expand-all').addEventListener('click', () => {
    tocEl.querySelectorAll('.toc-collapsible').forEach(sec => {
      sec.classList.remove('is-collapsed');
      sec.querySelector('.toc-chevron').textContent = '▾';
    });
  });
}

// ---------- Filters ----------
function wireFilters() {
  const filters = document.querySelectorAll('.filter-btn[data-filter]');
  filters.forEach(btn => {
    btn.addEventListener('click', () => {
      filters.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const f = btn.dataset.filter;
      compareEl.classList.remove('filter-changed', 'filter-singlesided');
      if (f === 'changed') compareEl.classList.add('filter-changed');
      if (f === 'singlesided') compareEl.classList.add('filter-singlesided');
    });
  });

  const search = document.getElementById('search');
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    document.querySelectorAll('.row').forEach(row => {
      if (!q) { row.style.removeProperty('display'); return; }
      const text = row.innerText.toLowerCase();
      row.style.display = text.includes(q) ? '' : 'none';
    });
  });
}

// ---------- Left-source toggle wiring ----------
function updateLeftHeaderText() {
  const title = document.getElementById('left-doc-title');
  const meta = document.getElementById('left-doc-meta');
  const appbar = document.getElementById('appbar-title');
  if (leftSource === 'em-vigor') {
    title.textContent = 'Legislação em vigor';
    const ct = IN_FORCE.CT || {};
    meta.innerHTML = `Fonte principal: <a href="${ct.source}" target="_blank" rel="noopener">pgdlisboa.pt</a> · consultado ${ct.scrapedAt}`;
    appbar.innerHTML = 'Em vigor &nbsp;→&nbsp; Proposta de Lei <em>19 mai 2026</em>';
  } else {
    title.textContent = 'Trabalho XXI';
    meta.textContent = 'Proposta do Governo · 24 Jul 2025 · 60 pp.';
    appbar.innerHTML = 'Anteprojeto <em>24 jul 2025</em> &nbsp;→&nbsp; Proposta de Lei <em>19 mai 2026</em>';
  }
}

function setLeftSource(src) {
  if (src !== 'anteprojeto' && src !== 'em-vigor') return;
  if (src === leftSource) return;
  leftSource = src;
  localStorage.setItem(LS_KEY, src);
  document.querySelectorAll('[data-left-source]').forEach(b => {
    const active = b.dataset.leftSource === src;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  updateLeftHeaderText();
  build();
  buildTOC();
  rebindScrollRefs();
  activeKey = null;
  updateActive();
}

document.querySelectorAll('[data-left-source]').forEach(b => {
  b.addEventListener('click', () => setLeftSource(b.dataset.leftSource));
});

// Active TOC item on scroll. Refs are rebound after every full re-render.
let rowEls = [];
let tocByTarget = {};
let activeKey = null;
function rebindScrollRefs() {
  rowEls = [...document.querySelectorAll('.row[id]')];
  const tocItems = [...document.querySelectorAll('.toc-item, .toc-section-head')];
  tocByTarget = Object.fromEntries(tocItems.map(t => [t.dataset.target, t]));
}
function updateActive() {
  const y = window.scrollY + 200;
  let active = null;
  for (const r of rowEls) {
    if (r.offsetTop <= y) active = r.id;
    else break;
  }
  if (active !== activeKey) {
    if (activeKey && tocByTarget[activeKey]) tocByTarget[activeKey].classList.remove('is-active');
    activeKey = active;
    if (activeKey && tocByTarget[activeKey]) {
      tocByTarget[activeKey].classList.add('is-active');
      const tocItem = tocByTarget[activeKey];
      const tocRect = tocItem.getBoundingClientRect();
      if (tocRect.top < 100 || tocRect.bottom > window.innerHeight - 50) {
        tocItem.scrollIntoView({ block: 'nearest' });
      }
    }
  }
}
let scrollPending = false;
window.addEventListener('scroll', () => {
  if (!scrollPending) {
    scrollPending = true;
    requestAnimationFrame(() => { updateActive(); scrollPending = false; });
  }
}, { passive: true });

// ---------- Init ----------
// Reflect persisted leftSource on the toggle buttons before first render so
// the active class doesn't briefly flash on the wrong button.
document.querySelectorAll('[data-left-source]').forEach(b => {
  const active = b.dataset.leftSource === leftSource;
  b.classList.toggle('is-active', active);
  b.setAttribute('aria-selected', active ? 'true' : 'false');
});
updateLeftHeaderText();
build();
buildTOC();
wireFilters();
rebindScrollRefs();
updateActive();
