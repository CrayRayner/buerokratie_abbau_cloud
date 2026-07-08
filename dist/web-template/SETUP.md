# Web-Viewer hochladen — Schritt fuer Schritt (idiotensicher)

Der Ordner `dist/web/` ist die fertige Website: statisches Frontend + `data.json`.
Kein Server-Code, kein Gesetzestext, kein `classify.js`. Laeuft auf normalem PHP-Hosting.

> **REGEL 0 — Wo Befehle eingeben:** ALLE `node ...`-Befehle laufen aus dem
> **Repo-Hauptordner** (da wo `package.json` liegt), NICHT aus `dist/`.
> Also zuerst immer:
> ```
> cd M:\buerokratie_abbau_cloud        (oder: cd "M:\Buerokratie abbau")
> ```
> Wenn du `Cannot find module ...\dist\dist\publish.js` siehst (dist DOPPELT im
> Pfad), stehst du im falschen Ordner — eine Ebene hoch (`cd ..`).
>
> **REGEL 1 — Platzhalter:** Zeichen wie `…`, `<name>` oder `[optional]` in
> Anleitungen NIE woertlich mitkopieren. Sie bedeuten "hier eigenen Wert einsetzen
> oder weglassen".

---

## Schritt 1 — Bundle bauen

```
cd M:\buerokratie_abbau_cloud
node dist/publish.js data/buerokratie.db "Datenstand Juli 2026" --web
```

(Im Haupt-Repo heisst die Quelle `data/buerokratie.final.db`. Ohne Argumente geht es
auch — dann findet publish.js die DB automatisch und nimmt das heutige Datum.)

Ergebnis: `dist/web/` mit index.html, app.js, style.css, vendor/, data.json,
export.csv, .htaccess, SETUP.md.

Hinweis: Eine schon vorhandene `dist/web/.htaccess` wird beim erneuten Bauen
**absichtlich nicht ueberschrieben** (dein eingetragener Pfad bleibt erhalten).
Willst du sie bewusst frisch aus dem Template haben: erst loeschen, dann bauen.

> **WICHTIG — dist.db gehoert NICHT auf den Server!** Die Web-Variante nutzt
> `data.json` (liegt schon in `dist/web/`) — dieselben Daten, nur als Datei, die
> der Browser direkt laden kann. Die `dist.db` (SQLite) braucht NUR die
> Electron-Desktop-App. Merkregel: **Web = data.json, Desktop = dist.db** —
> beide entstehen aus demselben publish.js-Lauf und sind immer synchron.

## Schritt 2 — Login-Benutzer anlegen

```
node dist/gen-htpasswd.js meinname
```

- Du waehlst nur den **Benutzernamen**; das **Passwort wird erzeugt** und EINMALIG
  angezeigt -> sofort in den Passwortmanager. Es wird nirgends im Klartext gespeichert.
- Weitere Benutzer spaeter: `node dist/gen-htpasswd.js --add zweitername`
- Die Datei `dist/web/.htpasswd` enthaelt nur Hashes und darf hochgeladen werden.

## Schritt 3 — Hochladen per SFTP

Den **gesamten Inhalt** von `dist/web/` in einen Ordner der Domain laden,
z. B. `toryn-gent.net/buerokratie/`.

> **Stolperfalle versteckte Dateien:** `.htaccess` und `.htpasswd` beginnen mit
> einem Punkt = auf Unix-Servern "versteckt". Viele FTP-Programme blenden sie aus!
> - FileZilla: Menue **Server -> "Anzeige versteckter Dateien erzwingen"**, dann F5
> - WinSCP: **Strg+Alt+H** (bzw. Einstellungen -> Oberflaeche -> versteckte Dateien)
> Nicht sichtbar heisst NICHT nicht vorhanden — erst einblenden, dann urteilen.

## Schritt 4 — .htpasswd-Pfad eintragen (der fummelige Schritt)

Apache braucht in der `.htaccess` den **absoluten Serverpfad** zur `.htpasswd`
(Zeile `AuthUserFile`). Den kennt nur der Server selbst — so findest du ihn:

> **Henne-Ei-Problem vorab:** Die .htaccess schuetzt ALLE Dateien im Ordner — auch
> deine Pfad-Helferdatei. Und einloggen geht noch nicht, weil AuthUserFile ja noch
> auf den Platzhalter zeigt (JEDER Login schlaegt fehl, egal was du eintippst).
> Deshalb den Schutz kurz ausschalten:

1. In der hochgeladenen `.htaccess` (per SFTP bearbeiten) die vier Auth-Zeilen mit
   `#` auskommentieren:
   ```
   # AuthType Basic
   # AuthName "Buerokratieabbau Bayern - bitte anmelden"
   # AuthUserFile /HIER/ABSOLUTEN/PFAD/EINTRAGEN/.htpasswd
   # Require valid-user
   ```
2. Eine Datei `pfad.php` mit genau diesem Inhalt in den Ordner hochladen:
   ```php
   <?php echo __DIR__ . '/.htpasswd'; ?>
   ```
3. Im Browser aufrufen — **mit https://** :
   `https://toryn-gent.net/buerokratie/pfad.php`
   -> zeigt den kompletten Pfad, z. B. `/homepages/12/d1234567/htdocs/buerokratie/.htpasswd`
4. Diesen Pfad in der `.htaccess` bei `AuthUserFile` eintragen und die vier
   `#` wieder entfernen (Schutz wieder AN).
5. **`pfad.php` auf dem Server LOESCHEN** (verraet sonst die Serverstruktur).

> Alternative ohne Gefummel: IONOS-Kundenmenue -> "Verzeichnisschutz" fuer den
> Ordner einrichten — der Hoster setzt .htaccess/.htpasswd selbst korrekt.
> Dann Schritt 2 + 4 komplett ueberspringen (Benutzer legst du im Menue an).

## Schritt 5 — Dashboard aufrufen

Einfach die **Ordner-URL** aufrufen (https!), z. B.:
```
https://www.toryn-gent.net/Buerokratieabbau/web/
```
Der Server liefert bei einer Ordner-URL automatisch die `index.html` aus
(Konvention "DirectoryIndex") — es gibt keine extra Datei aufzurufen.
Login-Popup -> Benutzer/Passwort aus Schritt 2 -> Dashboard erscheint.
Der CSV-Knopf oben rechts laedt die `export.csv`.

---

## Standard-Workflow: neue Daten veroeffentlichen (nach jedem Analyse-Lauf)

Das Erst-Setup (Schritte 1-5) machst du EINMAL. Danach ist der Standard-Weg
nach jedem abgeschlossenen Lauf (analyze + second-check durch):

```
cd M:\buerokratie_abbau_cloud
node dist/publish.js data/buerokratie.db "Datenstand <Monat Jahr>" --web
```

Dann per SFTP NUR diese zwei Dateien in den Web-Ordner hochladen (ueberschreiben):

```
dist/web/data.json      <- die neuen Ergebnisse
dist/web/export.csv     <- der neue CSV-Download
```

**Alles andere bleibt liegen:** `.htaccess` (dein AuthUserFile-Pfad!), `.htpasswd`
(alle Logins), index.html/app.js/style.css/vendor (aendern sich nur bei
Code-Updates am Viewer). Browser-Reload -> neue Zahlen da. Fertig.

> Derselbe publish-Lauf erzeugt auch die frische `dist/dist.db` fuer die
> Electron-Desktop-App — Web und Desktop bleiben automatisch synchron.

---

## Troubleshooting — Fehlerbild -> Ursache -> Loesung

| Fehlerbild | Ursache | Loesung |
|---|---|---|
| `Cannot find module ...\dist\dist\publish.js` (dist doppelt) | Befehl aus `dist/` heraus gestartet | `cd ..` — Befehle laufen vom Repo-Hauptordner |
| `Quelle nicht gefunden: …` | Platzhalter `…` woertlich mitkopiert | Platzhalter ersetzen oder weglassen |
| Login-Popup schon bei `pfad.php`, kein Passwort funktioniert | Henne-Ei: AuthUserFile zeigt noch auf Platzhalter | Schritt 4: Auth-Zeilen temporaer auskommentieren |
| `.htaccess`/`.htpasswd` "fehlen" im FTP-Programm | Versteckte Dateien (Punkt-Prefix) ausgeblendet | FileZilla: Server-Menue "versteckte Dateien erzwingen"; WinSCP: Strg+Alt+H |
| Zeichensalat im Login-Popup oder in `.htaccess` | Umlaute — HTTP-Header koennen nur ASCII/Latin-1 | Die gelieferte `.htaccess` ist absichtlich komplett ASCII; keine Umlaute einfuegen |
| "Nicht sicher" in der Adressleiste | Seite ueber `http://` aufgerufen | Immer `https://` benutzen; NIE Login-Daten auf einer "Nicht sicher"-Seite eingeben |
| Nach Login-Eingabe Fehler 500 | `AuthUserFile`-Pfad falsch/Tippfehler | Pfad aus `pfad.php` exakt uebernehmen (Schritt 4) |
| Seite laedt OHNE Login-Abfrage | `.htaccess` nicht mit hochgeladen (versteckte Datei!) oder Auth noch auskommentiert | Upload pruefen (versteckte Dateien einblenden), `#` vor den Auth-Zeilen entfernen |
| Dashboard leer / "Fehler beim Laden" | `data.json` fehlt oder Upload unvollstaendig | Kompletten Inhalt von `dist/web/` erneut hochladen |

## Sicherheits-Checkliste

- [x] Passwoerter nur **gehasht** in `.htpasswd` (nie Klartext)
- [x] `.htaccess`/`.htpasswd`/`*.md` werden **nicht ausgeliefert** (Regel in `.htaccess`)
- [x] **HTTPS erzwungen** (Redirect in `.htaccess`; http-Requests sind von der Auth
      ausgenommen, damit der Redirect VOR dem Login-Popup greift — sonst gingen
      Credentials im Klartext raus)
- [x] **HSTS gesetzt** (Browser erzwingt https ab dem ersten Besuch; gilt host-weit)
- [x] Sicherheits-Header (CSP, nosniff, Framing) gesetzt
- [x] Verzeichnis-Listing aus
- [ ] `pfad.php` nach Gebrauch geloescht (dein Schritt!)
- [ ] Login nur ueber `https://` getestet (nie bei "Nicht sicher")
- [ ] Redirect-Test: `http://…` aufrufen -> es MUSS sofort auf `https://` umspringen,
      OHNE dass vorher ein Login-Popup kommt. Kommt erst das Popup, ist die
      `.htaccess` auf dem Server veraltet (Abschnitt 1+2 aus dem Template nachziehen)
- [ ] Falls je ueber `http://` eingeloggt wurde: Passwort rotieren
      (`node dist/gen-htpasswd.js <name>` und neue `.htpasswd` hochladen)
- [ ] `.htpasswd` ist NICHT in git (per `.gitignore` ausgeschlossen — nicht aendern)
