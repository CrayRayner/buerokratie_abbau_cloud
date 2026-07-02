# Projekt: Bürokratieabbau Bayern

## ARBEITSREGELN — VERBINDLICH

1. **STOPP vor destruktiven Aktionen.** Führe NIEMALS ohne ausdrückliche Freigabe aus:
   - `node reset-analyze.js` (oder jedes DELETE/DROP/TRUNCATE)
   - `node analyzer/index.js` / `node pipeline.js` (Voll-Runs)
   - das Überschreiben/Löschen von `*.db`
   Frage vorher und warte auf "ja".

2. **Ein Fix ≠ ein Run.** Wenn du Code änderst: BESCHREIBE die Änderung und was sie bewirkt. Starte den Run NICHT selbst. Der User entscheidet, wann gelaufen wird.

3. **Bei Unsicherheit oder Designfrage** (z.B. Voting-Schwelle, Threshold): FRAGE und warte. Triff keine eigenmächtige Designentscheidung und setze sie nicht still um.

4. **Niemals `raw_analyses` oder `analyses` löschen**, um "neu anzufangen". Daten sind Beweismittel. Wenn ein Neulauf nötig ist, schlage es vor und begründe — lösche nichts selbst.

5. **Eine Aufgabe pro Schritt.** Erledige genau die angefragte Änderung, dann STOPP und berichte. Kein "ich mach gleich noch X".
