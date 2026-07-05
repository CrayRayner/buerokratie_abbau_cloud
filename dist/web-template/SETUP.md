# Web-Viewer hochladen (toryn-gent.net) — Schritt für Schritt

Der Ordner `dist/web/` ist die fertige Website: statisches Frontend + `data.json`.
Kein Server-Code, kein Gesetzestext, kein `classify.js`. Läuft auf PHP-Hosting.

## 1. Passwörter erzeugen (lokal, NICHT im Web)

```bash
node dist/gen-htpasswd.js kunde1 kunde2 ...
```

Das Skript fragt für jeden Benutzer ein Passwort ab und schreibt `dist/web/.htpasswd`
mit **gehashten** Passwörtern (Klartext wird nie gespeichert). Merke dir die Passwörter
sicher (Passwortmanager) — sie stehen nirgends im Klartext.

> Jeder Benutzer bekommt eine eigene Zeile/ein eigenes Passwort. Neue Benutzer später:
> `node dist/gen-htpasswd.js --add kunde3` (hängt an, ohne die anderen zu überschreiben).

## 2. Absoluten Pfad zur .htpasswd eintragen

Apache braucht in `.htaccess` den **absoluten Serverpfad** zur `.htpasswd`. So findest du ihn:

1. Lege kurz eine Datei `pfad.php` in denselben Upload-Ordner mit dem Inhalt:
   ```php
   <?php echo __DIR__ . '/.htpasswd'; ?>
   ```
2. Rufe sie einmal im Browser auf (`https://toryn-gent.net/<ordner>/pfad.php`) —
   sie zeigt den kompletten Pfad, z. B. `/kunden/homepages/xx/dxxxx/htdocs/<ordner>/.htpasswd`.
3. Diesen Pfad in `.htaccess` bei `AuthUserFile` eintragen.
4. **`pfad.php` danach wieder löschen.**

> Alternativ bietet IONOS im Kundenmenü „Verzeichnisschutz" an — das setzt `.htaccess`
> und `.htpasswd` mit korrektem Pfad automatisch. Dann brauchst du Schritt 2 nicht.

## 3. Per SFTP hochladen

Lade den **gesamten Inhalt** von `dist/web/` in einen Ordner deiner Domain, z. B.
`toryn-gent.net/buerokratie/`. Wichtig: die **versteckten** Dateien `.htaccess` und
`.htpasswd` müssen mit hoch (im SFTP-Client „versteckte Dateien anzeigen" aktivieren).

## 4. Testen

`https://toryn-gent.net/buerokratie/` aufrufen → Browser fragt nach Login → nach
korrekter Eingabe erscheint das Dashboard.

## Sicherheits-Checkliste (ist bereits vorbereitet)

- [x] Passwörter nur **gehasht** in `.htpasswd` (nie Klartext)
- [x] `.htaccess`/`.htpasswd`/`*.md` werden **nicht ausgeliefert** (Regel in `.htaccess`)
- [x] **HTTPS erzwungen** (Login-Daten nie über http)
- [x] Sicherheits-Header (CSP, nosniff, Framing) gesetzt
- [x] Verzeichnis-Listing aus
- [ ] `pfad.php` nach Gebrauch gelöscht (dein Schritt)
- [ ] `.htpasswd` **niemals** in git committen (ist per `.gitignore` ausgeschlossen)
