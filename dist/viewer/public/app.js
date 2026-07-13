// Bürokratieabbau Dashboard — Frontend
const PALETTE = {
  prioA: '#5a4fcf', prioB: '#2f8f7a', prioC: '#b3aa98', notRated: '#d8d2c4',
  land: '#3a9d6e', bund: '#e0a32e', eu: '#cf5b41',
  hoch: '#cf5b41', mittel: '#e0a32e', niedrig: '#86b06a',
  bars: ['#2f8f7a', '#5a4fcf', '#e0a32e', '#cf5b41', '#3a9d6e', '#6aa9d9', '#b3aa98', '#9b6fcf'],
  adressat: {
    'Gewerbe/Unternehmen': '#2f8f7a', 'Freie Berufe/Selbstständige': '#5a4fcf',
    'Agrarbetrieb': '#e0a32e', 'Verbraucher/Private': '#6aa9d9',
    'Behörde': '#b3aa98', 'unklar': '#d8d2c4'
  }
};

let DATA = null;
let charts = {};
let sortKey = 'priority', sortDir = 1;
let selectedRun = '';

async function loadRuns() {
  try {
    const res = await fetch('/api/runs');
    const { runs } = await res.json();
    const sel = document.querySelector('#run-select');
    if (!runs || !runs.length) { sel.style.display = 'none'; return; }
    sel.innerHTML = runs.map(r =>
      `<option value="${esc(r.name)}">${esc(r.name)}${r.dir === 'runs' ? ' · runs/' : ''}</option>`).join('');
    // Default: die Haupt-DB (data/), sonst der neueste Lauf
    selectedRun = (runs.find(r => r.dir === 'data') || runs[0]).name;
    sel.value = selectedRun;
  } catch { /* keine Läufe -> Haupt-DB */ }
  updateCsvLink();
}

function updateCsvLink() {
  const q = selectedRun ? '?run=' + encodeURIComponent(selectedRun) : '';
  document.querySelector('#csv-link').href = '/api/export/csv' + q;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
const $ = sel => document.querySelector(sel);

function scBadge(sc) {
  if (!sc || !sc.empfehlung) return '';
  const cls = { behalten: 'sc-behalten', herabstufen: 'sc-herabstufen', verwerfen: 'sc-verwerfen' }[sc.empfehlung] || 'sc-herabstufen';
  return ` <span class="badge ${cls}" title="Zweitcheck: ${esc(sc.begruendung || '')}">2.✓ ${esc(sc.empfehlung)}</span>`;
}

function adrBadge(v) {
  if (!v) return '';
  // Bewusst EIN neutraler Chip-Stil statt Regenbogenfarben pro Wert — die Prio-/
  // Rechtsbindungs-/Zweitcheck-Badges in derselben Zeile belegen schon Grün/Lila/
  // Amber/Rot, eine 6. Farbfamilie würde nur Verwechslungen stiften.
  return `<span class="badge adr-chip">${esc(v)}</span>`;
}

// Kombinierte Endwertung als kompakter Suffix aufs Prio-Badge — überschreibt die
// Prioritaet NIE, reine Anzeigehilfe. ✓ bestätigt · ‼ Bedenken · ✗ infrage gestellt.
function endstatusSuffix(sc) {
  if (!sc || !sc.empfehlung) return '';
  return { behalten: ' ✓', herabstufen: ' ‼', verwerfen: ' ✗' }[sc.empfehlung] || '';
}
function endstatusTitle(endstatus) {
  return endstatus ? `title="Endstatus: ${esc(endstatus)}"` : '';
}

// === Markierungen (localStorage — pro Browser/Gerät, pro Datenstand) ===
// Kein Server nötig: Auswahl lebt im Browser, Export der Auswahl passiert clientseitig.
let marks = new Set();
let marksKey = 'ba_marks';
let notes = {};              // key -> Notiztext (nur nicht-leere)
let notesKey = 'ba_notes';
function initMarks() {
  marksKey = 'ba_marks::' + (DATA.dataDate || 'default'); // neuer Datenstand = frische Auswahl
  notesKey = 'ba_notes::' + (DATA.dataDate || 'default');
  try { marks = new Set(JSON.parse(localStorage.getItem(marksKey) || '[]')); }
  catch { marks = new Set(); }
  try { notes = JSON.parse(localStorage.getItem(notesKey) || '{}') || {}; }
  catch { notes = {}; }
  updateMarkUi();
}
function saveMarks() {
  localStorage.setItem(marksKey, JSON.stringify([...marks]));
  updateMarkUi();
}
function setMark(key, on) { if (on) marks.add(key); else marks.delete(key); }

// Leere Notiz = Eintrag loeschen (haelt Zaehler und Export sauber)
function setNote(key, text) {
  if (text && text.trim()) notes[key] = text;
  else delete notes[key];
  localStorage.setItem(notesKey, JSON.stringify(notes));
  updateMarkUi();
}
function notePreview(key) {
  const t = (notes[key] || '').trim().replace(/\s+/g, ' ');
  return t.length > 60 ? t.slice(0, 60) + '…' : t;
}
function renderNoteCell(cell, key) {
  const t = notePreview(key);
  cell.innerHTML = t ? esc(t) : '<span class="note-add">＋ Notiz</span>';
}
function updateMarkUi() {
  const nNotes = Object.keys(notes).length;
  const parts = [];
  if (marks.size) parts.push(marks.size + ' markiert');
  if (nNotes) parts.push(nNotes + ' Notiz' + (nNotes === 1 ? '' : 'en'));
  $('#mark-count').textContent = parts.join(' · ');
  $('#btn-export-marked').disabled = marks.size === 0;
  $('#btn-clear-marks').disabled = marks.size === 0;
  // Sichern lohnt auch, wenn es NUR Notizen gibt
  $('#btn-save-marks').disabled = marks.size === 0 && nNotes === 0;
}

// Auswahl als Datei sichern/laden — fuer Geraetewechsel, Backup, Weitergabe an
// Kollegen. Bewusst JSON statt CSV: die CSV ist fuers Lesen in Excel (und wird
// dort beim Speichern gern verfaelscht); die JSON traegt die internen Schluessel
// verlustfrei. Ein Format fuer Menschen, eines fuer die Maschine.
function exportMarksFile() {
  if (!marks.size && !Object.keys(notes).length) return;
  const payload = {
    type: 'ba-marks',
    dataDate: DATA.dataDate || null,
    saved: new Date().toISOString(),
    marks: [...marks],
    notes // Notizen wandern im selben Stand mit (gleiche Datei, ein Begriff: "Auswahl")
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'auswahl-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importMarksFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let p = null;
    try { p = JSON.parse(reader.result); } catch { /* unten gemeldet */ }
    if (!p || p.type !== 'ba-marks' || !Array.isArray(p.marks)) {
      flashMarkMsg('Keine gültige Auswahl-Datei.');
      return;
    }
    // Nur Schluessel uebernehmen, die es im aktuellen Datenstand wirklich gibt —
    // Sicherungen aus einem anderen Datenstand richten so keinen stillen Schaden an.
    const valid = new Set(DATA.hits.map(h => h._key));
    let ok = 0, unknown = 0;
    for (const k of p.marks) {
      if (valid.has(k)) { if (!marks.has(k)) ok++; marks.add(k); }
      else unknown++;
    }
    // Notizen: nicht-destruktiver Merge — eine schon vorhandene EIGENE Notiz wird
    // nie von einer importierten ueberschrieben (eigene Arbeit geht nie verloren).
    let nOk = 0, nSkip = 0;
    if (p.notes && typeof p.notes === 'object') {
      for (const [k, txt] of Object.entries(p.notes)) {
        if (!valid.has(k) || typeof txt !== 'string' || !txt.trim()) { unknown += valid.has(k) ? 0 : 1; continue; }
        if (notes[k] && notes[k].trim() && notes[k] !== txt) { nSkip++; continue; }
        if (!notes[k]) nOk++;
        notes[k] = txt;
      }
      localStorage.setItem(notesKey, JSON.stringify(notes));
    }
    saveMarks();
    applyFilters();
    const bits = [ok + ' Markierungen übernommen'];
    if (nOk) bits.push(nOk + ' Notizen übernommen');
    if (nSkip) bits.push(nSkip + ' Notizen übersprungen (eigene vorhanden)');
    if (unknown) bits.push(unknown + ' unbekannt (anderer Datenstand?)');
    flashMarkMsg(bits.join(', ') + '.');
  };
  reader.onerror = () => flashMarkMsg('Datei konnte nicht gelesen werden.');
  reader.readAsText(file);
}

let markMsgTimer = null;
function flashMarkMsg(text) {
  const el = $('#mark-msg');
  el.textContent = text;
  clearTimeout(markMsgTimer);
  markMsgTimer = setTimeout(() => { el.textContent = ''; }, 6000);
}

function exportMarkedCsv() {
  const rows = DATA.hits.filter(h => marks.has(h._key));
  if (!rows.length) return;
  const escC = v => { const s = String(v == null ? '' : v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const header = ['Gesetz', 'Normtyp', 'Normstelle', 'Belegstelle', 'Pflichttyp', 'Adressat', 'Belegtext',
    'Aenderungsvorschlag', 'Risiko', 'Prioritaet', 'ensemble_votes', 'beleg_sicherheit',
    'rechtlich_gebunden', 'human_review', 'Zweitcheck', 'Zweitcheck_Begruendung', 'Endstatus', 'URL', 'Notiz'];
  const lines = [header.join(';')];
  for (const h of rows) {
    const sc = h.secondCheck;
    lines.push([h.title, h.normType, h.normstelle, h.beleg, h.category, h.adressat,
      h.burden, h.proposed, h.risks, h.priority, h.confidence,
      h.grounded ? 'hoch' : 'niedrig', h.legalFull, h.needsReview ? 'JA' : 'nein',
      sc ? sc.empfehlung || '' : '', sc ? sc.begruendung || '' : '',
      h.endstatus || '', h.url, notes[h._key] || ''].map(escC).join(';'));
  }
  // BOM voran, damit Excel die Umlaute als UTF-8 erkennt
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'markierte-belegstellen.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function load() {
  try {
    // Datenquelle konfigurierbar: Electron-Viewer -> '/api/data' (Default),
    // statische Web-Variante -> 'data.json' (per window.VIEWER_CFG in index.html gesetzt).
    const src = (window.VIEWER_CFG && window.VIEWER_CFG.data) || '/api/data';
    const res = await fetch(src);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    DATA = await res.json();
    // Stabiler Schlüssel pro Belegstelle: docId + laufende Nummer innerhalb des
    // Gesetzes. Stabil, solange derselbe Datenstand geladen ist (Reihenfolge in
    // data.json/DB ist fix) — Markierungen sind deshalb pro Datenstand gespeichert.
    const seen = {};
    for (const h of DATA.hits) { seen[h.docId] = (seen[h.docId] || 0) + 1; h._key = h.docId + '#' + seen[h.docId]; }
    initMarks();
    render();
  } catch (e) {
    $('#meta-run').textContent = 'Fehler beim Laden: ' + e.message;
  }
}

function render() {
  const { kpi, charts: ch, hits } = DATA;

  // Viewer: nur Datenstand anzeigen (Modellname bewusst nicht — kein Leak welches LLM).
  $('#meta-run').textContent = DATA.dataDate ? 'Datenstand: ' + DATA.dataDate : '';
  const hd = $('#help-datastand');
  if (hd) hd.textContent = DATA.dataDate ? 'Datenstand dieser Auswertung: ' + DATA.dataDate : '';

  const showEmpty = kpi.analyzed === 0;
  $('#empty').classList.toggle('hidden', !showEmpty);
  document.querySelector('.chart-grid').classList.toggle('hidden', showEmpty);
  document.querySelector('.table-card').classList.toggle('hidden', showEmpty);

  renderKpis(kpi);
  if (showEmpty) { $('#kpi-grid').innerHTML = kpiCards(kpi); return; }

  renderCharts(ch);
  buildFilterOptions(ch, hits);
  applyFilters();
}

function kpiCards(k) {
  const cards = [
    { v: k.totalDocs, l: 'Normen gesamt', cls: '' },
    { v: k.analyzed, l: 'analysiert (aktueller Stand)', cls: 'accent' },
    { v: k.prioA, l: 'Reform-Prio A', note: 'frei + relevant', cls: 'a' },
    { v: k.landesrechtFrei, l: 'Landesrecht — frei kürzbar', note: 'beste Reform-Kandidaten', cls: 'good' },
    { v: k.needsReview, l: 'Prüfung nötig', cls: 'warn' },
    { v: k.hitsTotal, l: 'Belegstellen', note: k.ungrounded + ' ungrounded', cls: '' }
  ];
  return cards.map(c => `
    <div class="kpi ${c.cls}">
      <div class="kpi-value">${esc(c.v)}</div>
      <div class="kpi-label">${esc(c.l)}</div>
      ${c.note ? `<div class="kpi-note">${esc(c.note)}</div>` : ''}
    </div>`).join('');
}
function renderKpis(k) { $('#kpi-grid').innerHTML = kpiCards(k); }

function renderCharts(ch) {
  const doughnut = (id, labels, data, colors) => {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart($('#' + id), {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '62%',
        plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { family: 'Space Grotesk', size: 12 } } } }
      }
    });
  };
  const bar = (id, labels, data, colors, horizontal) => {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart($('#' + id), {
      type: 'bar',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 5, maxBarThickness: 28 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        indexAxis: horizontal ? 'y' : 'x',
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: !horizontal, color: 'rgba(0,0,0,0.05)' }, ticks: { font: { family: 'Space Grotesk', size: 11 } } },
          y: { grid: { display: horizontal, color: 'rgba(0,0,0,0.05)' }, ticks: { font: { family: 'Space Grotesk', size: 11 } } }
        }
      }
    });
  };

  const p = ch.priority;
  doughnut('chart-priority',
    ['A', 'B', 'C', 'nicht bewertet'],
    [p.A, p.B, p.C, p['nicht bewertet']],
    [PALETTE.prioA, PALETTE.prioB, PALETTE.prioC, PALETTE.notRated]);

  const l = ch.legal;
  doughnut('chart-legal',
    ['Landesrecht', 'Bund', 'EU'],
    [l['Landesrecht'], l['Bund'], l['EU']],
    [PALETTE.land, PALETTE.bund, PALETTE.eu]);

  const cats = ch.categories.slice(0, 8);
  bar('chart-category',
    cats.map(c => c.name), cats.map(c => c.count),
    cats.map((_, i) => PALETTE.bars[i % PALETTE.bars.length]), true);

  const rel = ch.relevance;
  bar('chart-relevance',
    ['hoch', 'mittel', 'niedrig'],
    [rel.hoch, rel.mittel, rel.niedrig],
    [PALETTE.hoch, PALETTE.mittel, PALETTE.niedrig], false);

  const adr = Object.entries(ch.adressat || {}).sort((a, b) => b[1] - a[1]);
  doughnut('chart-adressat',
    adr.map(([k]) => k), adr.map(([, v]) => v),
    adr.map(([k]) => PALETTE.adressat[k] || '#c9c2b4'));
}

function buildFilterOptions(ch, hits) {
  fillSelect('#f-priority', ['A', 'B', 'C', 'nicht bewertet'].filter(p => ch.priority[p] > 0));
  fillSelect('#f-legal', ['Landesrecht', 'Bund', 'EU'].filter(x => ch.legal[x] > 0));
  fillSelect('#f-category', ch.categories.map(c => c.name));
  fillSelect('#f-adressat', Object.keys(ch.adressat || {}).sort((a, b) => (ch.adressat[b] || 0) - (ch.adressat[a] || 0)));
}
function fillSelect(sel, values) {
  const el = $(sel);
  const keep = el.querySelector('option').outerHTML;
  el.innerHTML = keep + values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
}

function applyFilters() {
  const q = $('#f-search').value.trim().toLowerCase();
  const fp = $('#f-priority').value;
  const fl = $('#f-legal').value;
  const fc = $('#f-category').value;
  const fa = $('#f-adressat').value;
  const fr = $('#f-review').checked;
  const fsc = $('#f-sc').checked;
  const fm = $('#f-marked').checked;

  let rows = DATA.hits.filter(h => {
    if (fp && h.priority !== fp) return false;
    if (fl && h.legal !== fl) return false;
    if (fc && h.category !== fc) return false;
    if (fa && h.adressat !== fa) return false;
    if (fr && !h.needsReview) return false;
    if (fsc && !(h.secondCheck && h.secondCheck.empfehlung !== 'behalten')) return false;
    if (fm && !marks.has(h._key)) return false;
    if (q && !(h.title.toLowerCase().includes(q) || (h.beleg || '').toLowerCase().includes(q) || (h.proposed || '').toLowerCase().includes(q) || (notes[h._key] || '').toLowerCase().includes(q))) return false;
    return true;
  });

  const prioRank = { A: 0, B: 1, C: 2, 'nicht bewertet': 3 };
  rows.sort((a, b) => {
    let x, y;
    if (sortKey === 'priority') { x = prioRank[a.priority] ?? 9; y = prioRank[b.priority] ?? 9; }
    else { x = String(a[sortKey] || '').toLowerCase(); y = String(b[sortKey] || '').toLowerCase(); }
    return (x < y ? -1 : x > y ? 1 : 0) * sortDir;
  });

  const grouped = $('#f-group').checked;
  if (grouped) {
    const laws = new Set(rows.map(r => r.docId)).size;
    $('#result-count').textContent = `${laws} Gesetze · ${rows.length} Belegstellen`;
    renderGrouped(rows);
  } else {
    $('#result-count').textContent = `${rows.length} Belegstellen`;
    renderTable(rows);
  }
}

function renderTable(rows) {
  const body = $('#hits-body');
  body.innerHTML = rows.map((h, i) => {
    const review = (h.needsReview
      ? '<span class="badge review">JA</span>'
      : '<span class="badge ok">nein</span>') + scBadge(h.secondCheck);
    return `
    <tr class="row${marks.has(h._key) ? ' marked' : ''}" data-i="${i}">
      <td class="cell-mark"><input type="checkbox" class="mark-box" data-k="${esc(h._key)}" ${marks.has(h._key) ? 'checked' : ''} title="Für Export markieren"></td>
      <td class="cell-title">${esc(h.title.slice(0, 90))}<small>${esc(h.docId)} · ${esc(h.normType)}</small></td>
      <td><span class="badge prio-${esc(h.priority)}" ${endstatusTitle(h.endstatus)}>${esc(h.priority)}${endstatusSuffix(h.secondCheck)}</span></td>
      <td>${esc(h.category)}<br>${adrBadge(h.adressat)}</td>
      <td><span class="badge legal-${esc(h.legal)}">${esc(h.legal)}</span></td>
      <td>${esc(h.confidence)}</td>
      <td>${review}</td>
      <td class="cell-beleg">
        ${h.normstelle ? `<span class="norm-chip">${esc(h.normstelle)}</span>` : ''}
        <div class="beleg-text">${esc((h.beleg || h.burden || '').slice(0, 130))}${(h.beleg || '').length > 130 ? '…' : ''}</div>
        ${h.proposed ? `<div class="prop">▸ ${esc(h.proposed.slice(0, 130))}${h.proposed.length > 130 ? '…' : ''}</div>` : ''}
      </td>
      <td class="cell-note" data-nk="${esc(h._key)}">${notePreview(h._key) ? esc(notePreview(h._key)) : '<span class="note-add">＋ Notiz</span>'}</td>
    </tr>`;
  }).join('');

  // expand on click
  body.querySelectorAll('tr.row').forEach(tr => {
    tr.addEventListener('click', () => toggleDetail(tr, rows[+tr.dataset.i]));
  });

  // Markieren: stopPropagation, sonst klappt der Klick auch die Detailzeile auf
  body.querySelectorAll('.mark-box').forEach(cb => {
    cb.addEventListener('click', e => {
      e.stopPropagation();
      setMark(cb.dataset.k, cb.checked);
      saveMarks();
      cb.closest('tr').classList.toggle('marked', cb.checked);
      if ($('#f-marked').checked) applyFilters(); // Zeile ggf. aus dem Filter nehmen
    });
  });
}

function bestPrio(hits) {
  const rank = { A: 0, B: 1, C: 2, 'nicht bewertet': 3 };
  return hits.reduce((best, h) => ((rank[h.priority] ?? 9) < (rank[best] ?? 9) ? h.priority : best), 'nicht bewertet');
}

function renderGrouped(rows) {
  const groups = new Map();
  for (const h of rows) {
    if (!groups.has(h.docId)) groups.set(h.docId, []);
    groups.get(h.docId).push(h);
  }
  const rank = { A: 0, B: 1, C: 2, 'nicht bewertet': 3 };
  const arr = [...groups.values()].sort((a, b) => (rank[bestPrio(a)] ?? 9) - (rank[bestPrio(b)] ?? 9));

  const body = $('#hits-body');
  body.innerHTML = arr.map((hits, gi) => {
    const f = hits[0];
    const bp = bestPrio(hits);
    const review = hits.some(h => h.needsReview)
      ? '<span class="badge review">JA</span>' : '<span class="badge ok">nein</span>';
    // Zweitcheck-Summe über die Vorschläge des Gesetzes
    const scCounts = {};
    for (const h of hits) if (h.secondCheck && h.secondCheck.empfehlung) scCounts[h.secondCheck.empfehlung] = (scCounts[h.secondCheck.empfehlung] || 0) + 1;
    const scSum = ['verwerfen', 'herabstufen', 'behalten'].filter(k => scCounts[k])
      .map(k => `<span class="badge ${{ behalten: 'sc-behalten', herabstufen: 'sc-herabstufen', verwerfen: 'sc-verwerfen' }[k]}">${scCounts[k]}× ${k}</span>`).join(' ');
    const sub = hits.map(h => `
      <li>
        <input type="checkbox" class="mark-box mark-sub" data-k="${esc(h._key)}" ${marks.has(h._key) ? 'checked' : ''} title="Für Export markieren">
        ${h.normstelle ? `<span class="norm-chip">${esc(h.normstelle)}</span>` : ''}
        <span class="badge prio-${esc(h.priority)}" ${endstatusTitle(h.endstatus)}>${esc(h.priority)}${endstatusSuffix(h.secondCheck)}</span>
        ${adrBadge(h.adressat)}
        <b>${esc(h.category)}</b> — ${esc((h.beleg || h.burden || '').slice(0, 160))}
        ${h.proposed ? `<div class="prop">▸ ${esc(h.proposed.slice(0, 180))}</div>` : ''}
        ${notes[h._key] ? `<div class="note-line">📝 ${esc(notes[h._key])}</div>` : ''}
        ${h.secondCheck ? `<div class="sc-line">${scBadge(h.secondCheck)} ${esc(h.secondCheck.begruendung || '')}</div>` : ''}
      </li>`).join('');
    return `
      <tr class="row grp" data-g="${gi}">
        <td class="cell-mark"><input type="checkbox" class="mark-law" data-g="${gi}" title="Ganzes Gesetz (alle Belegstellen) markieren"></td>
        <td class="cell-title">${esc(f.title.slice(0, 90))}<small>${esc(f.docId)} · ${esc(f.normType)}</small></td>
        <td><span class="badge prio-${esc(bp)}">${esc(bp)}</span></td>
        <td>${hits.length} Belegstellen</td>
        <td><span class="badge legal-${esc(f.legal)}">${esc(f.legal)}</span></td>
        <td>${esc(f.confidence)}</td>
        <td>${review}</td>
        <td class="cell-beleg">${scSum || '<span class="muted">▸ aufklappen</span>'}</td>
        <td class="cell-note">${(n => n ? n + ' 📝' : '')(hits.filter(h => notes[h._key]).length)}</td>
      </tr>
      <tr class="grp-detail hidden" data-gd="${gi}"><td colspan="9"><ul class="hit-list">${sub}</ul></td></tr>`;
  }).join('');

  body.querySelectorAll('tr.grp').forEach(tr => {
    tr.addEventListener('click', () => {
      const d = body.querySelector(`tr.grp-detail[data-gd="${tr.dataset.g}"]`);
      if (d) d.classList.toggle('hidden');
    });
  });

  // Gesetz-Checkbox: Zustand aus den Einzel-Marks ableiten (voll/teilweise/leer),
  // Klick markiert ALLE Belegstellen des Gesetzes auf einmal.
  const lawState = (cb, hits) => {
    const n = hits.filter(h => marks.has(h._key)).length;
    cb.checked = n === hits.length && n > 0;
    cb.indeterminate = n > 0 && n < hits.length; // "teilweise" = Strich statt Haken
  };
  body.querySelectorAll('.mark-law').forEach(cb => {
    const hits = arr[+cb.dataset.g];
    lawState(cb, hits);
    cb.addEventListener('click', e => {
      e.stopPropagation();
      const on = cb.checked; // Zustand NACH dem Klick
      for (const h of hits) setMark(h._key, on);
      saveMarks();
      const det = body.querySelector(`tr.grp-detail[data-gd="${cb.dataset.g}"]`);
      if (det) det.querySelectorAll('.mark-sub').forEach(s => { s.checked = on; });
      if ($('#f-marked').checked) applyFilters();
    });
  });
  body.querySelectorAll('.mark-sub').forEach(cb => {
    cb.addEventListener('click', e => {
      e.stopPropagation();
      setMark(cb.dataset.k, cb.checked);
      saveMarks();
      const det = cb.closest('tr.grp-detail');
      const law = body.querySelector(`.mark-law[data-g="${det.dataset.gd}"]`);
      if (law) lawState(law, arr[+det.dataset.gd]);
      if ($('#f-marked').checked) applyFilters();
    });
  });
}

function toggleDetail(tr, h) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('detail')) { next.remove(); return; }
  document.querySelectorAll('tr.detail').forEach(d => d.remove());
  const det = document.createElement('tr');
  det.className = 'detail';
  det.innerHTML = `<td colspan="9"><div class="detail-inner">
    <dl class="dl">
      <dt>Gesetz</dt><dd>${esc(h.title)}</dd>
      <dt>Normstelle</dt><dd>${esc(h.normstelle) || '<span style="color:var(--ink-faint)">nicht eindeutig auflösbar</span>'}</dd>
      <dt>Belegstelle</dt><dd>${esc(h.beleg) || '—'}</dd>
      <dt>Belastung</dt><dd>${esc(h.burden) || '—'}</dd>
      <dt>Vorschlag</dt><dd>${esc(h.proposed) || '—'}</dd>
      <dt>Risiko</dt><dd>${esc(h.risks) || '—'}</dd>
      <dt>Rechtsbindung</dt><dd>${esc(h.legalFull)}</dd>
      <dt>Adressat</dt><dd>${adrBadge(h.adressat) || 'unklar'}</dd>
      <dt>Relevanz / Entlastung</dt><dd>${esc(h.relevance) || '—'} / ${esc(h.relief) || '—'}</dd>
      <dt>Beleg verankert</dt><dd>${h.grounded ? '<span class="badge ok">ja</span>' : '<span class="badge review">nein</span>'}</dd>
      <dt>Quelle</dt><dd><a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.url)}</a></dd>
      ${h.secondCheck ? `<dt>Zweitcheck</dt><dd>${scBadge(h.secondCheck)} &nbsp;${esc(h.secondCheck.begruendung || '')}
        <br><small class="muted">Unternehmensbindung: ${esc(h.secondCheck.unternehmensbindung || '?')} · Rechtsbindung ok: ${esc(h.secondCheck.rechtsbindung_respektiert || '?')} · Hebel korrekt: ${esc(h.secondCheck.hebel_richtung_korrekt || '?')} · Beleg plausibel: ${esc(h.secondCheck.beleg_plausibel || '?')}</small></dd>
        <dt>Endstatus</dt><dd><b>${esc(h.endstatus || h.priority)}</b> <small class="muted">(Prioritätsbuchstabe bleibt unverändert — Endstatus ist eine kombinierte Anzeige, kein automatisches Downgrade)</small></dd>` : ''}
    </dl>
    <div class="note-block">
      <label class="note-label" for="note-edit-field">Eigene Notiz</label>
      <textarea id="note-edit-field" class="note-edit"
        placeholder="Notiz zu dieser Belegstelle… (speichert automatisch, nur in diesem Browser)">${esc(notes[h._key] || '')}</textarea>
      <small class="muted">Automatisch gespeichert · persönlich (dieser Browser) · in „Auswahl sichern" und „Markierte als CSV" enthalten</small>
    </div>
  </div></td>`;
  tr.after(det);

  // Notiz-Feld: speichert bei jedem Tastendruck (localStorage ist billig) und
  // aktualisiert die Vorschau-Zelle der zugehörigen Zeile live.
  const ta = det.querySelector('.note-edit');
  ta.addEventListener('input', () => {
    setNote(h._key, ta.value);
    const cell = tr.querySelector('td.cell-note');
    if (cell) renderNoteCell(cell, h._key);
  });
}

function fmtDate(s) {
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// events — Viewer hat KEINEN Run-Picker/Refresh (fester Datensatz).
['#f-search', '#f-priority', '#f-legal', '#f-category', '#f-adressat', '#f-review', '#f-sc', '#f-group', '#f-marked'].forEach(s =>
  $(s).addEventListener('input', applyFilters));

// Markierungs-Aktionen. Löschen zweistufig statt confirm() — window.confirm ist im
// Electron-Renderer kaputt (Fokusverlust, stille nulls), darum nie verwenden.
$('#btn-export-marked').addEventListener('click', exportMarkedCsv);
$('#btn-save-marks').addEventListener('click', exportMarksFile);
$('#btn-load-marks').addEventListener('click', () => $('#file-load-marks').click());
$('#file-load-marks').addEventListener('change', e => {
  if (e.target.files[0]) importMarksFile(e.target.files[0]);
  e.target.value = ''; // sonst feuert 'change' nicht, wenn dieselbe Datei nochmal gewaehlt wird
});
let clearArmed = null;
$('#btn-clear-marks').addEventListener('click', () => {
  const btn = $('#btn-clear-marks');
  if (!clearArmed) {
    btn.textContent = 'Wirklich alle löschen?';
    clearArmed = setTimeout(() => { btn.textContent = 'Markierungen leeren'; clearArmed = null; }, 4000);
    return;
  }
  clearTimeout(clearArmed); clearArmed = null;
  btn.textContent = 'Markierungen leeren';
  marks.clear();
  saveMarks();
  applyFilters();
});
document.querySelectorAll('th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = 1; }
    applyFilters();
  });
});

// Hilfe-Overlay (Legende für Nicht-Techniker)
$('#btn-help').addEventListener('click', () => $('#help-overlay').classList.remove('hidden'));
$('#help-close').addEventListener('click', () => $('#help-overlay').classList.add('hidden'));
$('#help-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'help-overlay') $('#help-overlay').classList.add('hidden');
});

load();
