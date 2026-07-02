const SYSTEM_PROMPT = `Analysiere diesen Gesetzestext auf Bürokratiebelastungen FÜR UNTERNEHMEN (Gewerbe, Gaststätten, Handwerk, Bau, Industrie, Handel, Dienstleister, Landwirtschaft, Freiberufler).

KRITERIUM: Nur aufnehmen, wenn die Norm private Unternehmen direkt betrifft. NICHT aufnehmen, wenn sie nur Behörden, Gerichte, Beamte, Ministerien, öffentliche Bedienstete oder interne Verwaltungsabläufe regelt.

HINWEIS: Eine Pflicht ist auch dann unternehmensrelevant, wenn sie sich an den BETREIBER einer Anlage / eines Hafens / eines Betriebs oder an gewerbliche Tätigkeiten richtet — selbst wenn das Wort "Unternehmen" nicht explizit fällt und zusätzlich Privatpersonen betroffen sind.

AUSSCHLUSS: Eine ZUSTÄNDIGKEITSVERORDNUNG (regelt, welche BEHÖRDE für was zuständig ist) ist NIEMALS eine Unternehmensbelastung — auch wenn sie Branchen wie "pharmazeutische Unternehmen" oder "Apotheken" nennt. Die Belastung liegt im zugrundeliegenden Fachgesetz, nicht in der Zuständigkeitsregel. Solche Normen: priority "nicht bewertet".

Kategorien:
SCHRIFTFORM - Schriftform, eigenhändige Unterschrift, Papierform, Original, beglaubigte Kopie
BERICHTSPFLICHT - Jahresbericht, Tätigkeitsbericht, statistische Meldung, regelmäßige Berichtspflicht
DOKUMENTATION - Dokumentationspflicht, Aufzeichnungspflicht, Protokollpflicht, Registerpflicht, Aufbewahrungspflicht
GENEHMIGUNG - Genehmigungs-, Erlaubnis-, Zulassungs-, Anerkennungspflicht, Zustimmungsvorbehalt
ANZEIGE - Anzeigepflicht, Änderungsanzeige, Vorabanzeige, Mitteilungspflicht
NACHWEIS - Nachweispflicht, Vorlagepflicht, Bescheinigungspflicht, Prüfpflicht, Sachverständigennachweis
SCHWELLENWERT - Starre Schwellenwerte, niedrige Bagatellgrenzen, kurze Fristen
MEHRFACHZUSTÄNDIGKEIT - Parallele Zuständigkeiten, Medienbrüche, fehlende digitale Schnittstellen

WICHTIG - ANTI-HALLUZINATION:
- Nur Paragrafen/Artikel nennen, die WÖRTLICH im obigen Text vorkommen
- KEINE Paragrafen erfinden oder implizieren
- Wenn unsicher: paragraph-Feld leer lassen statt zu raten

proposed_change soll KONKRETE Entbürokratisierung beschreiben, nicht nur "Digitalisierung":
- Pflicht STREICHEN (ersatzlos)
- Schwellenwert ANHEBEN (ab welchem Betrag?)
- Genehmigung in ANZEIGE umwandeln
- Bagatellgrenze EINFÜHREN (unter X Euro entfällt Pflicht)
- Sunset-Klausel (Befristung, automatische Evaluierung)
- One-Stop-Shop (eine Stelle statt mehrere)
- Frist VERLÄNGERN (von X auf Y Tage)
- Standardisierung (einheitliches Format / Muster)
- Digitalisierung (NUR wenn der Haupthebel)

ADRESSAT (wer trägt die Pflicht?): Gewerbe/Unternehmen | Freie Berufe/Selbstständige | Agrarbetrieb | Verbraucher/Private | unklar
(Freie Berufe/Selbstständige = z.B. Hebammen, Ärzte, Architekten, Fahrlehrer, Bergführer — die Person IST der Betrieb.)

JSON:
{
  "hits": [{
    "paragraph": "Kurzes wörtliches Zitat aus dem Text (eine Phrase, exakt kopiert, KEINE Paraphrase)",
    "category": "SCHRIFTFORM|BERICHTSPFLICHT|DOKUMENTATION|GENEHMIGUNG|ANZEIGE|NACHWEIS|SCHWELLENWERT|MEHRFACHZUSTÄNDIGKEIT",
    "burden_type": "Kurze Beschreibung (1 Satz)",
    "priority": "A|B|C",
    "business_relevance": "hoch|mittel|niedrig",
    "relief_potential": "hoch|mittel|niedrig",
    "baymog_suitability": "hoch|mittel|niedrig",
    "adressat": "Gewerbe/Unternehmen|Freie Berufe/Selbstständige|Agrarbetrieb|Verbraucher/Private|unklar",
    "proposed_change": "Konkrete Formulierungshilfe: Streichung, Anhebung, Umwandlung oder Vereinfachung",
    "legal_restrictions": "Rechtliche Grenzen des Abbaus (z.B. zwingendes Bundes-/EU-Recht), sonst leer",
    "risks": "Risiken der Entbürokratisierung"
  }],
  "summary": "1 Satz: Gesamtbewertung der Bürokratiebelastung für Unternehmen"
}

Regeln:
- PRIORITÄT A NUR bei direktem, belegbarem Entlastungspotenzial für Unternehmen (nicht automatisch vergeben)
- Nur Treffer mit business_relevance = "hoch" oder "mittel" aufnehmen
- Max 5 Treffer (die relevantesten für Unternehmen)
- Wenn keine unternehmensrelevanten Belastungen: { "hits": [], "summary": "Keine unternehmensrelevanten Bürokratiebelastungen gefunden" }`;

function buildPrompt(docTitle, docText) {
  const truncated = docText.length > 80000
    ? docText.substring(0, 80000) + '\n\n[... TEIL GEKÜRZT]'
    : docText;

  return `${SYSTEM_PROMPT}\n\nTITEL: ${docTitle}\n\nTEXT:\n${truncated}\n\nJSON-Antwort:`;
}

module.exports = { buildPrompt };
