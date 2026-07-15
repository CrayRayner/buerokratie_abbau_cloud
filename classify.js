// classify.js — gemeinsame, deterministische Klassifikatoren (kein LLM).
// "Ableiten statt raten" — genau wie Reform-Priorität. Doc-Ebene, aus Titel + Textanfang.

// Adressat: WER wird belastet? Bewusst neutral — die Scope-Entscheidung
// (zählen freie Berufe mit?) trifft der Mensch per Filter, nicht der Code.
// Reihenfolge = Priorität (erster Treffer gewinnt): Behörde-Ausschluss zuerst.
function classifyAddressee(title, text) {
  // Ganzer Text, nicht nur der Anfang: Signalwörter (z.B. "Betreiber") stehen oft
  // erst nach der Präambel/Einleitungsformel. Regex-Scan ist auch auf 700k Zeichen
  // trivial billig, kein Grund künstlich zu kappen.
  const titleLower = (title || '').toLowerCase();
  const t = (titleLower + ' ' + (text || '')).toLowerCase();

  // 1) Behörde/Organisation — NUR am TITEL prüfen, nicht am Volltext: fast jede
  // Verordnung enthält irgendwo eine Boilerplate-Zuständigkeitsklausel ("zuständig
  // ist die Kreisverwaltungsbehörde"), das macht sie nicht zur Zuständigkeitsverordnung.
  // Am Titel ist das Signal zuverlässig, weil es dort der ZWECK des Gesetzes ist.
  if (/zuständigkeitsverordnung|zuständigkeiten der|übertragung von (aufgaben|befugnissen)|organisation der (gerichte|behörde)|abgrenzung der bezirke|geschäftsverteilung|errichtung des.{0,40}(ausschusses|amtes)/.test(titleLower)) {
    return 'Behörde';
  }
  // 2) Freie Berufe / Selbstständige
  if (/berufsordnung|ausbildungs-?\s*und\s*prüfungsordnung|prüfungsordnung für|hebamm|entbindungspfleger|\bärztin|\bärzte|\barzt\b|apothek|heilberuf|heilpraktik|physiotherap|psychotherap|logopäd|rechtsanwalt|steuerberater|wirtschaftsprüfer|architekt|ingenieur|vermessungsingenieur|fachsportlehrer|sportlehrer|bergführer|skiführer|schneesportlehrer|fahrlehrer|tierärzt|tierarzt|pflegefachfrau|pflegeberuf|freien beruf/.test(t)) {
    return 'Freie Berufe/Selbstständige';
  }
  // 3) Agrarbetrieb
  if (/tierzucht|milch|landwirt|agrar|fischerei|teichwirt|imker|weinbau|\bforst|jagd|tierhaltung|saatgut|dünge/.test(t)) {
    return 'Agrarbetrieb';
  }
  // 4) Gewerbe / Unternehmen
  if (/gaststätt|verkaufsstätt|\bgewerbe|handwerk|betreiber|beherbergung|\bhandel\b|industrie|bauprodukt|bauvorlage|bauart|biergarten|\bmarkt|betrieb|anlagenbetreiber|abfallentsorg|immissionsschutz/.test(t)) {
    return 'Gewerbe/Unternehmen';
  }
  // 5) Verbraucher / Private
  if (/verbraucher|private haushalte|privatperson|endkunde/.test(t)) {
    return 'Verbraucher/Private';
  }
  return 'unklar';
}

// ============================================================================
// Gemeinsame Helfer — EINZIGE Quelle für Logik, die vorher in api.js,
// export-hits.js, review-report.js, second-check.js und analyzer/index.js
// dupliziert war (und dort bereits zu driften begann: 3 Namen für legalShort,
// 3 Signaturen für reformPriority). Änderungen hier wirken überall zugleich.
// ============================================================================

// --- Rechtsbindung: Kurzform aus dem legal_restrictions-Volltext ---
// Rückgabe 'EU' | 'Bund' | 'Landesrecht' — idempotent (nimmt auch die eigene
// Kurzform entgegen), daher dürfen Aufrufer roh ODER vorklassifiziert übergeben.
function legalShort(lr) {
  const t = lr || '';
  if (/^EU/i.test(t)) return 'EU';
  if (/Bund/i.test(t)) return 'Bund';
  return 'Landesrecht';
}

// Anzeige-Label für CSV-Exporte (README dokumentiert "Landesrecht (frei)").
function legalDisplay(lr) {
  const s = legalShort(lr);
  return s === 'Landesrecht' ? 'Landesrecht (frei)' : s;
}

// --- Reform-Priorität = Umsetzbarkeit (Rechtsbindung) × Schwere (Relevanz) ---
// EU-gebunden -> kaum kürzbar -> C; Bund -> max B; Landesrecht (frei) -> bis A.
function reformPriority(lrOrShort, relevance) {
  const rel = (relevance || '').toLowerCase();
  const L = legalShort(lrOrShort);
  if (L === 'EU') return 'C';
  if (L === 'Bund') return rel === 'hoch' ? 'B' : 'C';
  return rel === 'hoch' ? 'A' : (rel === 'mittel' ? 'B' : 'C');
}

const PRIO_RANK = { A: 0, B: 1, C: 2 };

// Doc-Level-Rollup: BESTES Pro-Vorschlag-Ergebnis im Dokument (nicht der
// Doc-Schnitt) — ein Dokument mit gemischten Vorschlägen soll nicht auf einen
// mittleren Wert verwaschen. Fallback auf Doc-Relevanz, wenn keine Hits.
function bestHitPriority(lr, docRelevance, hits) {
  const L = legalShort(lr);
  let best = null;
  for (const h of (hits || [])) {
    const p = reformPriority(L, h.business_relevance || docRelevance);
    if (best === null || PRIO_RANK[p] < PRIO_RANK[best]) best = p;
  }
  return best || reformPriority(L, docRelevance);
}

// --- Verbatim-Grounding (Anti-Halluzination) ---
// Belegstelle zählt nur, wenn ein normalisierter 25-Zeichen-Ausschnitt wörtlich
// im Quelltext vorkommt. Exakt gespiegelt zum Aggregator-Verhalten.
function normMatch(s) {
  return (s || '').toLowerCase().replace(/[^a-zäöüß0-9]/g, '');
}
function isGrounded(paragraph, docText) {
  const np = normMatch(paragraph);
  const nt = normMatch(docText);
  if (np.length < 20) return false;
  const win = 25;
  for (let i = 0; i + win <= np.length; i += 5) {
    if (nt.includes(np.slice(i, i + win))) return true;
  }
  return false;
}

// --- Normstellen-Auflösung ("§ 3 Abs. 1") ---
// Normalisierter Index des Volltexts mit Rückabbildung auf die Original-Position
// — einmal pro Dokument bauen, für alle Hits wiederverwenden.
function buildNormMap(text) {
  const map = [];
  let norm = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i].toLowerCase();
    if (/[a-zäöüß0-9]/.test(c)) { norm += c; map.push(i); }
  }
  return { norm, map };
}

// Normstelle ableiten: direkt aus dem Zitat, wenn das Modell sie vorangestellt
// hat, sonst Prosa im Quelltext lokalisieren und §/Absatz davor greifen.
function resolveNorm(quote, text, nm) {
  const q = (quote || '').trim();
  const direct = q.match(/^§\s*(\d+[a-z]?)(?:\s*Abs\.?\s*(\d+)|\s*\((\d+)\))?/i);
  if (direct) {
    const abs = direct[2] || direct[3];
    return abs ? `§ ${direct[1]} Abs. ${abs}` : `§ ${direct[1]}`;
  }
  const qn = normMatch(q);
  if (qn.length < 12) return '';
  // Belegstelle im Volltext lokalisieren: erst die ersten 30 Zeichen zusammenhaengend
  // (praezise, haeufigster Fall). Scheitert das — typisch, wenn das Modell das Zitat
  // mit "..." gekuerzt hat und der 30er-Anker quer ueber die Luecke liegt — auf die
  // Fenster-Suche von isGrounded zurueckfallen: erstes woertlich passendes 25er-Fenster.
  // Dadurch bekommen auch gekuerzte (aber gegroundete) Zitate ihre Normstelle.
  let idx = nm.norm.indexOf(qn.slice(0, 30));
  if (idx < 0) {
    for (let i = 0; i + 25 <= qn.length; i += 5) {
      const j = nm.norm.indexOf(qn.slice(i, i + 25));
      if (j >= 0) { idx = j; break; }
    }
  }
  if (idx < 0) return '';
  const origPos = nm.map[idx];
  // +6 Zeichen über die Fundstelle hinaus, damit ein direkt am Zitat-Anfang
  // stehendes "§ 3" noch erfasst wird.
  const region = text.slice(0, origPos + 6);
  const paras = [...region.matchAll(/§\s*(\d+[a-z]?)/g)];
  if (!paras.length) return '';
  const last = paras[paras.length - 1];
  const between = text.slice(last.index, origPos + 1);
  const absMatches = [...between.matchAll(/\((\d+)\)/g)];
  const abs = absMatches.length ? absMatches[absMatches.length - 1][1] : '';
  return abs ? `§ ${last[1]} Abs. ${abs}` : `§ ${last[1]}`;
}

// --- Kombinierte Endwertung: Priorität + Zweitcheck-Urteil sichtbar zusammen ---
// ÜBERSCHREIBT die Priorität NIE automatisch (Trichter-Prinzip), reine Anzeige.
function endstatus(prio, verdict) {
  if (!verdict || !verdict.empfehlung) return prio;
  const suffix = { behalten: 'bestätigt', herabstufen: 'Bedenken', verwerfen: 'infrage gestellt' }[verdict.empfehlung];
  return suffix ? `${prio} · ${suffix}` : prio;
}

// --- Treffer-Array aus analyses.description robust parsen ---
function parseHits(desc) {
  try { const h = JSON.parse(desc || '[]'); return Array.isArray(h) ? h : []; }
  catch { return []; }
}

module.exports = {
  classifyAddressee,
  legalShort, legalDisplay, reformPriority, bestHitPriority, PRIO_RANK,
  normMatch, isGrounded, buildNormMap, resolveNorm,
  endstatus, parseHits
};
