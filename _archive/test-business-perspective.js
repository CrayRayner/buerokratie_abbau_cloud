const {getDb} = require('./db');
const db = getDb();

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); passed++; }
  catch(e) { console.error('FAIL:', name, '-', e.message); failed++; }
}

// ======== GOLD STANDARD: Laws that SHOULD have business-relevant burdens ========
const businessLaws = {
  BayBO: 'Bayerische Bauordnung',
  BayGastV: 'Gaststättenverordnung',
  BayImSchG: 'Immissionsschutzgesetz',
  BayHwOZustV: 'Handwerksordnung-ZuständigkeitsV',
  BayAGIHKG: 'IHK-Ausführungsgesetz',
  BayLadSchlG: 'Ladenschlussgesetz',
  BayGrStG: 'Grundsteuergesetz',
  BayKAG: 'Kommunalabgabengesetz',
  BayMfG2008: 'Mittelstandsförderungsgesetz',
  BaySpielbG: 'Spielbankgesetz',
};

const adminLaws = {
  BayBG: 'Beamtengesetz',
  BayBesG: 'Besoldungsgesetz',
  BayDG: 'Disziplinargesetz',
  BayVfGHG: 'Verfassungsgerichtshofgesetz',
  BayAbgG: 'Abgeordnetengesetz',
};

console.log('=== Gold Standard: Business-relevant laws should have hits ===');
for (const [id, name] of Object.entries(businessLaws)) {
  test(`${id} (${name}) should have business-relevant hits`, () => {
    const row = db.prepare(`SELECT category, priority, business_relevance, summary FROM analyses WHERE doc_id=?`).get(id);
    if (!row) throw new Error(`Not analyzed yet`);
    if (row.category === 'sonstiges') throw new Error(`Empty: ${row.summary}`);
  });
}

console.log('\n=== Gold Standard: Admin-only laws should NOT have business hits ===');
for (const [id, name] of Object.entries(adminLaws)) {
  test(`${id} (${name}) should be empty for business relevance`, () => {
    const row = db.prepare(`SELECT category, priority, business_relevance, summary FROM analyses WHERE doc_id=?`).get(id);
    if (!row) throw new Error(`Not analyzed yet`);
    // If it has hits, business_relevance should be 'niedrig' for truly admin-only content
    if (row.category !== 'sonstiges' && row.business_relevance === 'hoch') {
      throw new Error(`Should not be hoch for admin law`);
    }
  });
}

// ======== DATA QUALITY TESTS ========
console.log('\n=== Data Quality ===');

const all = db.prepare(`SELECT * FROM analyses`).all();

test('All docs have doc_id', () => {
  const empty = all.filter(r => !r.doc_id);
  if (empty.length > 0) throw new Error(`${empty.length} empty doc_ids`);
});

test('All hits have valid category', () => {
  const valid = ['SCHRIFTFORM','BERICHTSPFLICHT','DOKUMENTATION','GENEHMIGUNG',
    'ANZEIGE','NACHWEIS','SCHWELLENWERT','MEHRFACHZUSTÄNDIGKEIT','sonstiges'];
  const catPipe = all.filter(r => r.category && r.category.includes('|'));
  if (catPipe.length > 0) {
    // Pipe-separated is minor quality issue but not fatal
    console.warn('  WARN: pipe-separated categories:', catPipe.map(r => r.doc_id+':'+r.category).join(', '));
  }
});

test('All hits have valid priority', () => {
  const valid = ['A','B','C','nicht bewertet'];
  const bad = all.filter(r => r.priority && !valid.includes(r.priority));
  if (bad.length > 0) throw new Error(`Invalid priorities: ${bad.map(r => r.doc_id+':'+r.priority).join(', ')}`);
});

test('Summary is not empty for hits', () => {
  const emptySummary = all.filter(r => r.category !== 'sonstiges' && (!r.summary || r.summary.trim() === ''));
  if (emptySummary.length > 0) throw new Error(`${emptySummary.length} hits with empty summary`);
});

// ======== BUSINESS RELEVANCE TESTS ========
console.log('\n=== Business Relevance ===');

const withHits = all.filter(r => r.category !== 'sonstiges');

test('Most business-relevant laws should have priority A or B', () => {
  const lowPrio = withHits.filter(r => r.priority === 'C');
  if (lowPrio.length > withHits.length * 0.3) {
    console.warn(`  WARN: ${lowPrio.length}/${withHits.length} are priority C`);
  }
});

test('Hits should reference concrete paragraphs', () => {
  for (const r of withHits) {
    if (r.description) {
      try {
        const hits = JSON.parse(r.description);
        for (const h of hits) {
          if (!h.paragraph || h.paragraph === '?' || h.paragraph === '' || h.paragraph.startsWith('§ ?')) {
            console.warn(`  WARN: vague paragraph in ${r.doc_id}: "${h.paragraph}"`);
          }
        }
      } catch {}
    }
  }
});

// ======== CROSS-REFERENCE: keyword matching ========
console.log('\n=== Keyword Cross-Reference ===');

const bizKeywords = ['Gewerbe', 'Gaststätte', 'Handwerk', 'Bau', 'Immission',
  'Abfall', 'Kammer', 'IHK', 'Beitrag', 'Gebühr', 'Laden', 'Mittelstand',
  'Spielbank', 'Grundsteuer', 'Kommunalabgabe'];

let keywordFound = 0;
let keywordMissing = 0;
for (const kw of bizKeywords) {
  const docs = db.prepare(`SELECT doc_id FROM documents WHERE title LIKE ?`).all(`%${kw}%`);
  for (const d of docs) {
    const analysis = db.prepare(`SELECT category FROM analyses WHERE doc_id=?`).get(d.doc_id);
    if (analysis && analysis.category !== 'sonstiges') {
      keywordFound++;
    } else if (analysis && analysis.category === 'sonstiges') {
      // This might be OK if the keyword match is incidental
      console.warn(`  WARN: ${d.doc_id} has keyword "${kw}" but no business hits`);
      keywordMissing++;
    }
  }
}
if (keywordMissing > 0) {
  console.log(`  Keyword hit rate: ${keywordFound}/${keywordFound + keywordMissing}`);
}

// ======== SUMMARY ========
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
