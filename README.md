# Hebammen Lounge – Praxisbuchung

GitHub Pages + Supabase. **Stand: Testprojekt, noch nicht produktiv eingerichtet.**

## Seiten
- `index.html`: Login und Buchungen der Kolleginnen
- `admin.html`: Vickys Verwaltung, Buchungen, CSV-Monatsauswertung, Monatsabschluss und Rechnungsversand

Einzige buchbare Einheit: **gesamte Praxis**. Bruttopreise: 16 €/Stunde (volle Stunden, 08–22 Uhr), 120 € / Tag (08–22 Uhr), 300 € / Wochenende (Samstag 08 Uhr bis Sonntag 22 Uhr). Die Datenbank sperrt Überschneidungen.

## GitHub Pages einschalten
GitHub → Repository → **Settings → Pages → Build and deployment → Source: GitHub Actions**. Der Workflow in `.github/workflows/pages.yml` veröffentlicht nur die sechs Frontenddateien. Die Datenbank oder E-Mail-Funktion werden **nicht** auf GitHub Pages betrieben.

## Supabase anschließen
1. Ein eigenes Supabase-Projekt möglichst in einer EU-Region erstellen.
2. Im SQL Editor zuerst `supabase/schema.sql`, danach `supabase/migrations/20261028_invoice_dispatch.sql` ausführen (nur in neuem Projekt; bei Bestandsdaten vorher Backup).
3. Email-OTP-Anmeldung konfigurieren. In `config.js` **ausschließlich** öffentliche Project URL und Publishable/Anon Key eintragen, **niemals** service_role, Datenbankpasswort oder E-Mail-Passwort.
4. Vicky mit bestätigter E-Mail anmelden und **ausschließlich im Supabase SQL Editor** zum Admin machen, nachdem ihre Identität überprüft wurde. Andere Kolleginnen muss sie freigeben.
5. Alle RLS-Berechtigungen mit mindestens zwei echten Kolleginnen-Testkonten testen: fremde Buchungen dürfen keine persönlichen Details preisgeben, Admin-Aktionen müssen verweigert werden.

## Rechnungsstellung / WEB.DE
Die Edge Function `supabase/functions/close-month/index.ts` erstellt nach Vickys manuellem Monatsabschluss pro Kollegin eine PDF-Sammelrechnung und versendet sie mit **WEB.DE SMTP auf Port 465**. Der Versand wird **nicht** von GitHub Pages ausgeführt.

- Rechnungsaussteller, Steuerart, Zahlungskonditionen und die Aktivierung `delivery_enabled` werden ausschließlich in `private.invoice_settings` auf Supabase eingestellt (zunächst **false**).
- Secrets ausschließlich unter Supabase Edge Functions: `WEBDE_SMTP_USER`, `WEBDE_SMTP_PASSWORD`, `INVOICE_ALLOWED_ORIGIN`. Siehe `SUPABASE-WEBDE-SECRETS.example`. Niemals in GitHub einchecken.
- Funktion separat mit Supabase CLI bereitstellen: `supabase functions deploy close-month` (Konfiguration `verify_jwt=true`).
- SMTP/WEB.DE-Limits, Zustellung und Fehlerbehandlung mit Testkonten prüfen. Supabase Auth-Login-Mails sind eine **separate** Mailkonfiguration.
- Aktuell erfolgt die Rechnungsstellung **im Portal, nicht in MIYA**; CSV-Export für MIYA ist vorbereitet. Doppelte Rechnungen vermeiden.

## Wichtig vor Live-Betrieb
Das Projekt ist nur lokal mit simulierten Backendantworten getestet. Ein echter Supabase-Sicherheits-/RLS-Test und die Konfiguration von Backups, DSGVO, Rechnungsanschrift, Umsatzsteuer, E-Rechnungspflicht, revisionssicherem Archiv und Berichtigungen/Stornos stehen aus. **Die PDF ist keine strukturierte E-Rechnung** und es gibt noch kein vollständiges Storno-/Berichtigungsverfahren. Keine echten Rechnungen versenden, bevor diese Punkte geklärt sind.

Weitere Details: `SECURITY.md` und die Kommentare in SQL/Edge Function.

## Lokale Prüfungen
```bash
node --check app.js
node tests/check-config.cjs
node tests/check-edge-syntax.cjs
python tests/browser_smoke.py # optional: Playwright + Chromium
```
