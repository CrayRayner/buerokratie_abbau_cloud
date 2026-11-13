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

// --- Gliederung eines Normtexts: § (Verordnungen), Art. (bayerische Gesetze), Anlagen ---
// EINZIGE Stelle, die weiß, was eine Gliederungsgrenze ist — genutzt vom Splitter
// (analyzer/index.js) UND von resolveNorm, damit beide dieselbe Sicht aufs Gesetz haben.
//
// Echte Überschriften stehen im Korpus ALLEIN in ihrer Zeile ("Art. 3", der Titel folgt
// in der nächsten Zeile). Bewusst KEINE Grenze sind:
//   "Art. 3 Allgemeine Anforderungen"  -> Zeile der Inhaltsübersicht am Textanfang
//   "§ 12 gilt entsprechend …"         -> Fließtext, der zufällig am Zeilenanfang steht
//   "§ 35 BauGB", "§ 2 des Gesetzes"   -> Verweis auf eine andere Norm
// Gemessen am Korpus (729 Docs): 15.960 solche Überschriften in 727 Docs, 99,5 %
// fortlaufend nummeriert. Anlagen: "Anlage 2", "Anlage 1.3: …", "Anlage (zu § 3)".
const HEADING_SRC = '(?:^|\\n)[ \\t]*(?:' +
  '(Art\\.|§)[ \\t\\u00a0]*(\\d+[a-z]?)[ \\t]*(?=\\n|$)' +
  '|Anlagen?(?:[ \\t]+(\\d+(?:\\.\\d+)*[a-z]?))?[ \\t]*(?=\\n|$|:|\\(zu\\b|zu\\b)' +
  ')';

// Liefert alle Überschriften in Dokumentreihenfolge:
//   index = Zeilenanfang der Überschrift, end = Ende der Überschriftszeile,
//   kind  = '§' | 'Art.' | 'Anlage', num = Nummer ('' bei unnummerierter Anlage),
//   label = Anzeigeform ("Art. 28", "§ 3", "Anlage 2").
function findHeadings(text) {
  const out = [];
  const re = new RegExp(HEADING_SRC, 'g');
  let m;
  while ((m = re.exec(text || '')) !== null) {
    const kind = m[1] || 'Anlage';
    const num = m[1] ? m[2] : (m[3] || '');
    out.push({
      index: m.index + (m[0][0] === '\n' ? 1 : 0),
      end: m.index + m[0].length,
      kind, num,
      label: kind === 'Anlage' ? ('Anlage' + (num ? ' ' + num : '')) : `${kind} ${num}`
    });
  }
  return out;
}

// Alle Fundstellen eines Teilstrings (gedeckelt, damit Floskeln nicht ausufern).
function allIndexes(hay, needle, cap) {
  const out = [];
  let j = hay.indexOf(needle);
  while (j >= 0 && out.length < cap) { out.push(j); j = hay.indexOf(needle, j + 1); }
  return out;
}

// Liegt die Position in einer Zeile der Inhaltsübersicht ("§ 5 Eintragungsantrag …",
// Nummer UND Titel in einer Zeile)? Solche Übersichten stehen nicht nur am Textanfang,
// sondern vor jedem Teil/Abschnitt — ein Fund dort ist nie die eigentliche Regelung.
function isTocLine(text, pos) {
  const ls = text.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*(?:Art\.|§)[ \t ]*\d+[a-z]?[ \t]+\S/.test(text.slice(ls, ls + 80));
}

// Zitat im Volltext lokalisieren -> Position im ORIGINALtext (oder -1).
//  1) Ganzes Zitat wörtlich (Normalfall). Bei mehreren Fundstellen die erste, die nicht
//     in der Inhaltsübersicht liegt.
//  2) Sonst stimmen die 25-Zeichen-Fenster des Zitats ab: jedes Fenster, das im Text
//     vorkommt, "schlägt" einen Zitatanfang vor (Fundstelle minus Fenster-Versatz).
//     Fenster aus demselben wörtlich übernommenen Stück schlagen denselben Anfang vor.
//     Ein Stück gilt als belastbar ab 2 Stimmen (= mind. 30 Zeichen am Stück wörtlich).
//     Es gewinnt das belastbare Stück, das im Zitat am WEITESTEN VORN steht — eine
//     Fundstelle zeigt dorthin, wo das Zitat beginnt, nicht wo es am längsten ist.
//     Das trägt gekürzte Zitate ("A … B") und vom Modell vorangestellte Normangaben
//     ("§ 3 Abs. 1: …"), ohne dass ein einzelnes zufällig passendes Fenster (häufige
//     Floskel irgendwo im Text) entscheidet.
function locateQuote(qn, text, nm) {
  if (!qn || qn.length < 12) return -1;
  const preferBody = cands => {
    const body = cands.find(j => !isTocLine(text, nm.map[j]));
    return nm.map[body !== undefined ? body : cands[0]];
  };
  const whole = allIndexes(nm.norm, qn, 20);
  if (whole.length) return preferBody(whole);

  // implizierter Zitatanfang -> { n: Stimmen, i: frühestes Fenster im Zitat, pos: dessen Fundstelle }
  const votes = new Map();
  for (let i = 0; i + 25 <= qn.length; i += 5) {
    for (const j of allIndexes(nm.norm, qn.slice(i, i + 25), 20)) {
      const v = votes.get(j - i);
      if (v) v.n++; else votes.set(j - i, { n: 1, i, pos: j });
    }
  }
  if (!votes.size) return -1;
  const all = [...votes.values()];
  const strong = all.filter(v => v.n >= 2);
  const pool = strong.length ? strong : all;
  const firstI = Math.min(...pool.map(v => v.i));
  let top = pool.filter(v => v.i === firstI);
  const best = Math.max(...top.map(v => v.n));
  top = top.filter(v => v.n === best);
  return preferBody(top.map(v => v.pos).sort((a, b) => a - b));
}

// Normstelle ableiten ("§ 3 Abs. 1", "Art. 28 Abs. 3", "Anlage 2"): das Zitat im Quelltext
// lokalisieren und die letzte ECHTE Überschrift davor nehmen (findHeadings).
// Früher: "letztes §-Zeichen vor der Fundstelle" — das griff auch Verweise ("§ 35 BauGB")
// und kannte kein "Art.", lieferte also für jedes bayerische Gesetz eine falsche Stelle.
function resolveNorm(quote, text, nm) {
  const q = (quote || '').trim();
  const origPos = locateQuote(normMatch(q), text, nm);
  if (origPos >= 0) {
    if (!nm.headings) nm.headings = findHeadings(text); // einmal pro Dokument, an nm gecacht
    let h = null;
    for (const cand of nm.headings) { if (cand.index <= origPos) h = cand; else break; }
    // Zitat liegt vor der ersten Überschrift (Einleitungsformel, Inhaltsübersicht):
    // lieber keine Normstelle als eine geratene.
    if (!h) return '';
    if (h.kind === 'Anlage') return h.label;
    // Absatz: letzter "(n)" am Zeilenanfang zwischen Überschrift und Fundstelle. +3, damit
    // ein Zitat, das selbst mit "(2) …" beginnt, seinen eigenen Absatz-Marker noch sieht.
    const between = text.slice(h.end, origPos + 3);
    const abs = [...between.matchAll(/(?:^|\n)[ \t]*\((\d+[a-z]?)\)/g)].pop();
    return abs ? `${h.label} Abs. ${abs[1]}` : h.label;
  }
  // Nicht lokalisierbar (z.B. sehr kurzes Zitat): nur wenn das Modell die Normstelle
  // selbst vorangestellt hat, diese übernehmen — sonst leer.
  const direct = q.match(/^(§|Art\.)\s*(\d+[a-z]?)(?:\s*Abs\.?\s*(\d+[a-z]?)|\s*\((\d+[a-z]?)\))?/i);
  if (direct) {
    const kind = direct[1] === '§' ? '§' : 'Art.';
    const abs = direct[3] || direct[4];
    return abs ? `${kind} ${direct[2]} Abs. ${abs}` : `${kind} ${direct[2]}`;
  }
  return '';
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
  normMatch, isGrounded, buildNormMap, findHeadings, resolveNorm,
  endstatus, parseHits
};
