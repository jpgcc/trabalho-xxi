/* === Reforma Laboral — Comparison app === */

import { marked } from 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js';
import { diffWordsWithSpace } from 'https://cdn.jsdelivr.net/npm/diff@5.2.0/+esm';

// ---------- Data ----------
const DATA = JSON.parse(document.getElementById('__data').textContent);

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

// Word-level diff between two MD bodies — returns {leftHTML, rightHTML} of the BODY only.
// We diff the markdown text directly and re-render. Diff tokens are wrapped with
// invisible sentinels so we can map them onto rendered HTML afterward — simpler approach:
// run diffWordsWithSpace, then synthesize a left markdown string (kept+removed) and a
// right markdown string (kept+added), render each via marked, wrap added/removed runs
// with <ins>/<del>.
function diffBodies(leftBody, rightBody) {
  const A = bodyForDiff(leftBody);
  const B = bodyForDiff(rightBody);
  if (!A && !B) return { left: '', right: '' };
  if (!A) return { left: '', right: decorateBody(renderMarkdown(B)) };
  if (!B) return { left: decorateBody(renderMarkdown(A)), right: '' };

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
  const status = articleStatus(row.left, row.right);
  const lbl = statusLabel(status, row.mode);
  const ariaId = `r-${idx}`;

  let leftHTML = '', rightHTML = '';
  if (row.left && row.right) {
    const { left, right } = diffBodies(row.left.body, row.right.body);
    leftHTML = left;
    rightHTML = right;
  } else if (row.left) {
    leftHTML = decorateBody(renderMarkdown(bodyForDiff(row.left.body)));
  } else if (row.right) {
    rightHTML = decorateBody(renderMarkdown(bodyForDiff(row.right.body)));
  }

  const classes = `row kind-article is-${status === 'identical' ? 'identical' : status === 'changed' ? 'changed' : status === 'left-only' ? 'leftonly' : 'rightonly'} ${row.left && row.right ? 'is-both' : ''} status-${status}`;

  const leftCell = row.left
    ? `<div class="cell left">${articleHeader(row.left, 'left')}<div class="cell-body">${leftHTML}</div></div>`
    : `<div class="cell left empty">sem correspondência no Anteprojeto</div>`;

  const rightCell = row.right
    ? `<div class="cell right">${articleHeader(row.right, 'right')}<div class="cell-body">${rightHTML}</div></div>`
    : `<div class="cell right empty">sem correspondência na Proposta de Lei</div>`;

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
  let total = 0, changed = 0, added = 0, removed = 0;
  rows.forEach(r => {
    if (r.kind !== 'article') return;
    if (r.diploma?.key !== dKey) return;
    if (r.mode !== mode) return;
    const s = articleStatus(r.left, r.right);
    if (s === 'identical') return;
    total++;
    if (s === 'changed') changed++;
    else if (s === 'right-only') added++;
    else if (s === 'left-only') removed++;
  });
  return { total, changed, added, removed };
}

function renderSectionBanner(row, idx) {
  const d = row.diploma;
  const mode = row.mode;
  const stats = diplomaArticleStats(DATA.rows, d.key, mode);
  const kicker = mode === 'addition' ? 'Aditamento' : 'Alteração';
  const dotColor = mode === 'addition' ? 'var(--add-rule)' : 'var(--accent-right)';

  const left = row.left, right = row.right;
  const leftArt = left ? `Art. ${left.propostaArtNum}` : '—';
  const rightArt = right ? `Art. ${right.propostaArtNum}` : '—';

  return `
    <div class="row kind-section is-section ${stats.total === 0 ? 'is-empty-section' : ''}" id="r-${idx}" data-diploma="${d.key}" data-mode="${mode}">
      <div class="section-banner">
        <div class="section-banner-kicker"><span class="section-banner-dot" style="background:${dotColor}"></span>${kicker} · Anteprojeto ${leftArt} · Proposta ${rightArt}</div>
        <div class="section-banner-title">${escapeHTML(d.label)}</div>
        <div class="section-banner-stats">
          <span><b>${stats.total}</b> artigo${stats.total === 1 ? '' : 's'}</span>
          ${stats.changed ? `<span><span class="pip" style="background:#B8651E"></span><b>${stats.changed}</b> alterado${stats.changed === 1 ? '' : 's'}</span>` : ''}
          ${stats.added ? `<span><span class="pip" style="background:var(--add-rule)"></span><b>${stats.added}</b> só na proposta</span>` : ''}
          ${stats.removed ? `<span><span class="pip" style="background:var(--del-rule)"></span><b>${stats.removed}</b> só no anteprojeto</span>` : ''}
        </div>
      </div>
    </div>`;
}

// ---------- Build ----------
function build() {
  let html = '';
  DATA.rows.forEach((row, idx) => {
    if (row.kind === 'preamble') html += renderRowPreamble(row, idx);
    else if (row.kind === 'objeto') html += renderRowToplevel(row, 'objeto', idx);
    else if (row.kind === 'group-banner') html += renderSectionBanner(row, idx);
    else if (row.kind === 'article') {
      if (articleStatus(row.left, row.right) !== 'identical') html += renderRowArticle(row, idx);
    }
    else if (row.kind === 'revogatoria') html += renderRowToplevel(row, 'revogatoria', idx);
    else if (row.kind === 'aplicacao') html += renderRowToplevel(row, 'aplicacao', idx);
  });
  gridEl.innerHTML = html;
}

function buildTOC() {
  let html = '';
  // Top: preamble + objeto
  html += `<div class="toc-section">
    <div class="toc-section-head" data-target="r-0"><span class="toc-section-dot"></span>Preâmbulo</div>
  </div>`;
  html += `<div class="toc-section">
    <div class="toc-section-head" data-target="r-1"><span class="toc-section-dot"></span>Objeto</div>
  </div>`;

  // For each group banner, list its articles
  DATA.rows.forEach((row, idx) => {
    if (row.kind === 'group-banner') {
      const stats = diplomaArticleStats(DATA.rows, row.diploma.key, row.mode);
      const modeTag = row.mode === 'addition' ? 'Aditamento' : 'Alteração';
      const dotColor = row.mode === 'addition' ? 'var(--add-rule)' : 'var(--accent-right)';
      html += `<div class="toc-section">
        <div class="toc-section-head" data-target="r-${idx}">
          <span class="toc-section-dot" style="background:${dotColor}"></span>
          ${row.diploma.key} · ${modeTag}
          <span class="toc-section-count">${stats.total}</span>
        </div>
        <div class="toc-items">`;
      DATA.rows.forEach((r2, i2) => {
        if (r2.kind !== 'article') return;
        if (r2.diploma?.key !== row.diploma.key) return;
        if (r2.mode !== row.mode) return;
        const status = articleStatus(r2.left, r2.right);
        if (status === 'identical') return;
        const sample = r2.right || r2.left;
        const sub = r2.right?.subtitle || r2.left?.subtitle || '';
        const num = sample?.articleNum || '';
        let tag = '';
        if (status === 'changed') tag = '<span class="toc-tag changed">±</span>';
        else if (status === 'right-only') tag = '<span class="toc-tag added">+</span>';
        else if (status === 'left-only') tag = '<span class="toc-tag removed">−</span>';
        html += `<div class="toc-item" data-target="r-${i2}" data-status="${status}">
          <span class="toc-num">${escapeHTML(num)}</span>
          <span class="toc-label">${escapeHTML(sub)}</span>
          ${tag}
        </div>`;
      });
      html += `</div></div>`;
    }
  });

  // Final
  const revIdx = DATA.rows.findIndex(r => r.kind === 'revogatoria');
  const aplIdx = DATA.rows.findIndex(r => r.kind === 'aplicacao');
  if (revIdx >= 0) html += `<div class="toc-section"><div class="toc-section-head" data-target="r-${revIdx}"><span class="toc-section-dot"></span>Norma revogatória</div></div>`;
  if (aplIdx >= 0) html += `<div class="toc-section"><div class="toc-section-head" data-target="r-${aplIdx}"><span class="toc-section-dot"></span>Aplicação no tempo</div></div>`;

  tocEl.innerHTML = html;

  tocEl.addEventListener('click', e => {
    const t = e.target.closest('[data-target]');
    if (!t) return;
    const el = document.getElementById(t.dataset.target);
    if (el) {
      const y = el.getBoundingClientRect().top + window.scrollY - 130;
      window.scrollTo({ top: y, behavior: 'smooth' });
    }
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

// ---------- Init ----------
build();
buildTOC();
wireFilters();

// Active TOC item on scroll
const rowEls = [...document.querySelectorAll('.row[id]')];
const tocItems = [...document.querySelectorAll('.toc-item, .toc-section-head')];
const tocByTarget = Object.fromEntries(tocItems.map(t => [t.dataset.target, t]));
let activeKey = null;
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
      // scroll TOC into view if needed
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
updateActive();
