# Sicherheitskonzept und Grenzen

Dieses Frontend ist **öffentlich und rein statisch**. GitHub Pages kann weder Passwörter/Secrets sicher aufbewahren noch API-Rechte durch Verstecken von HTML-Dateien erzwingen. Personenbezogene Daten liegen ausschließlich in Supabase, nicht im GitHub-Repository.

## Durchgesetzte Schutzmechanismen

- **Authentifizierung:** E-Mail-OTP über Supabase Auth; Login-Sessions im Tab-gebundenen `sessionStorage` (Token ist im Browser zugänglich; Benutzung nur auf vertrauenswürdigen Geräten). Abmelden verwirft die lokale Session und fordert serverseitige Abmeldung an.
- **Least Privilege:** PostgreSQL RLS bei `profiles`, `reservations`, `tariffs`. Browserrolle `authenticated` erhält ausschließlich Tabellen-`SELECT`; **keine direkten Inserts/Updates/Deletes**.
- **Serverseitige Rollenprüfung:** Adminzugang nur über `profiles.role='admin'` + `active=true` und DB-geprüfte `private.is_admin()`. `admin.html` ist öffentlich, gibt aber keine zusätzlichen Rechte. Namen lassen sich selbst setzen, **nicht** Rolle/Status/E-Mail.
- **Buchungsschutz:** Ausschließliche serverseitige `book_practice`-Funktion prüft freigegebene Profile, Stunden-/Tages-/Wochenend-Zeitfenster in `Europe/Berlin`, Zukunft, Tarifbetrag, Buchung für andere nur als Admin. Exclusion Constraint (GiST über `tstzrange`) verhindert Doppelbuchungen auch bei parallelen Requests.
- **Datensparsamkeit:** Kolleginnen sehen nur eigene Buchungsdetails. Alle freigeschalteten Kolleginnen können über `busy_slots` belegte Zeitfenster sehen, jedoch keine fremden Identitäten, Notizen oder Preise. Nur Admin darf Profile und Monatsdaten aller Nutzerinnen lesen. Keine Patientinnen-/Gesundheitsdaten erfassen.
- **Schutz vor Skript-Einschleusung:** Nutzereingaben in HTML werden maskiert; keine CDN-Skripte, keine Inline-JavaScript-Handler; strenge `Content-Security-Policy` via `<meta>` und `no-referrer`. GitHub Pages setzt keine frei konfigurierbaren Sicherheits-HTTP-Header; Meta-CSP bietet weniger Schutz als echte Response-Header.
- **Monatsabschluss & Rechnungsmails:** RLS-gesteuerte Admin-RPC + gesonderte Supabase Edge Function mit geprüftem JWT; Service-Key und WEB.DE-SMTP-Passwort nur als Supabase-Servergeheimnisse. DB-Rechnungsnummern/Snapshots sind pro Kollegin und Monat eindeutig. Private PDF-Ablage, Admin-only-Download. Versandfehler führen zu `failed` oder `review`, bei nicht eindeutig fehlgeschlagenen Vorgängen keine automatische Wiederholung.
- **CSV-Export:** Semikolon-getrennt, konsequent gequotet, `=`/`+`/`-`/`@` nach Leerraum neutralisiert. CSV ist ein **Datenexport**, keine MIYA-Integration.
- **GitHub Actions:** nur Lesezugriff auf Repository + notwendige Pages/ID-Token-Permissions; statisches Artefakt enthält nur freigegebene Frontend-Dateien, keine SQL- oder Testdateien. CI prüft, dass keine `service_role`/Secret Supabase-Keys in `config.js` stehen.

## Vor dem Betrieb umsetzen / entscheiden

1. Separates Supabase-Projekt in geeigneter EU-Region, wirksame RLS-Livetests und passende AV-Verträge/DSGVO-Dokumentation.
2. Einmalcode-Mail-Templates, SMTP, Ratenbegrenzungen und ggf. CAPTCHA/Einladungsworkflow gegen Missbrauch.
3. Aktiviertes HTTPS, Zugangskontrolle auf persönliche E-Mail-Konten, regelmäßige Kontrolle der Admin-Mitglieder und Konten.
4. Rechtsgrundlage/Datenschutzhinweise für Speicherung von Kontaktdaten und Buchungs-/Abrechnungsdaten; Lösch- und Aufbewahrungsfristen; regelmäßige Backups sowie Wiederherstellungsprobe.
5. Vertragsregeln zu Stornierungen, Umbuchungen, Buchungskorrekturen und verbindlichem Abschluss. Derzeit erlauben Funktionen kostenfreies Stornieren **vor Beginn**, danach nicht mehr. Nachträgliche Rechnungs-/Buchhaltungskorrekturen sind nicht implementiert.
6. Vor produktivem Rechnungsversand muss die Steuerberatung die **Steuerart, Rechnungs-Pflichtangaben, E-Rechnungspflicht, zulässigen Versandweg und Archivierung** klären. Die PDF-Erzeugung ist keine EN-16931-E-Rechnung und kein GoBD-konformes Komplettarchiv. Es gibt noch kein automatisches Storno-/Berichtigungsverfahren.
7. WEB.DE als E-Mail-Dienstanbieter, AVV, Datenverarbeitung und E-Mail-Transportweg datenschutzrechtlich bewerten; WEB.DE SMTP nur serverseitig auf Port 465 mit TLS nutzen; kein WEB.DE-Kennwort im GitHub-Repository.
8. Unklare Provider-Antworten (z. B. Timeout) oder festhängender Status `sending`: manuell beim Mailanbieter prüfen. Nicht pauschal erneut versenden; `review` erfordert manuelle Entscheidung.
7. Produktiver Supabase-Test mit mehreren echten Konten. Die enthaltenen UI-Tests simulieren API-Antworten und testen **nicht** die tatsächlich aktivierten Supabase-Policies.

## Manueller Berechtigungs-Abnahmetest

- **Gast, ohne Token:** `GET /rest/v1/reservations` und `POST /rest/v1/rpc/busy_slots` dürfen keine Buchungsdetails liefern.
- **Unfreigegeben:** Kann `update_my_name`, aber `book_practice` und `busy_slots` müssen fehlschlagen. Keine Adminfunktion darf laufen.
- **Kollegin A:** `GET /rest/v1/reservations` enthält nur eigene Datensätze, `busy_slots` zeigt nur Start-/Endzeiten. `book_practice(p_for_user=B)` und `cancel_reservation(booking_id_von_B)` müssen fehlschlagen. Direkte HTTP-`POST/PATCH/DELETE`-Aufrufe gegen `reservations` und `profiles` müssen abgewiesen werden.
- **Kollegin B:** Kann Kollegin A nicht sehen oder administrieren. Ein zeitgleich gesendeter Buchungswunsch mit identischem Zeitfenster muss mit **Konflikt** zurückgewiesen werden.
- **Admin Vicky:** Kann beide Kolleginnen sehen, Freigaben verwalten, Monats-CSV exportieren. Abmeldung muss den Zugriff beenden.

## Grenzen

Dieses Projekt speichert nach Konfiguration Rechnungs-Snapshots und PDF-Dateien im privaten Supabase Storage, bietet aber **keine nachgewiesen GoBD-konforme, unveränderliche Langzeitarchivierung**. Die Nutzung des Begriffs „sicher“ beschreibt eine konkrete mehrschichtige Schutzkonzeption, **keine Garantie** gegen alle Angriffe oder eine abgeschlossene DSGVO-/Penetrationstest-Abnahme.
