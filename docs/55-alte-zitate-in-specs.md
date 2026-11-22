---
description: Die aktiven Specs zitieren die alten deutschen Werkzeugsätze; diese Spec hat das Inventar erhoben, die Vertragsstellen nachgezogen und historische Belege mit Datum markiert.
status: active
---

# Alte Zitate in den aktiven Specs

`docs/54` hat alle agentengelesenen Texte englisch gemacht: Refusals, Meldungen der
Extension und die Werkzeugbeschreibungen. **Die aktiven Specs zitierten die alten
deutschen Sätze weiter wörtlich.** Zwei Abnahmekriterien prüften dadurch etwas
anderes, als sie behaupteten. Diese Spec hat sie nachgezogen.

**Abgrenzung:** `docs/54` hat drei Dateien selbst nachgezogen — `docs/05`
(`## MCP-Werkzeug`, Kriterium 4), `docs/45` (Kriterium 7) und `docs/03`
(`## MCP über stdio (der Vertrag)`, Kriterium 4) samt der dort zitierten
`description`-Zellen. Alles Weitere war Gegenstand dieser Spec.

## Das Inventar (erhoben 2026-11-22)

Der Befehl ist die Quelle der Tabelle; er sucht die alten Sätze und die Aussagen
über sie:

```
grep -rnE 'Keine Extension verbunden|Die Extension hat nicht geantwortet|Unbekanntes[[:space:]]+Tool|Kein Agenten-Tab|Es sind schon fünf|Die Seite lädt noch|Diese Seite kann die|Der Parameter ist ungültig|Kein Element passt zu|Das Element ist nicht sichtbar|Das Element ist kein beschreibbares Feld|Passwortfelder sind gesperrt|Der Selektor ist ungültig|Zu diesem `frame`|Mehrere Rahmen passen|Der Code im Agenten-Tab|Der Code hat nicht rechtzeitig|Das Ergebnis ist zu groß|Das Ergebnis lässt sich nicht|Das Bild ist auch nach dem Verkleinern|Das Transkript ließ sich nicht lesen|Der Tab ist nicht im Vordergrund|Keine Untertitelspur|Die Bridge konnte den Status|Die Extension konnte den Status|Die Extension konnte die Anfrage|browser_[a-z_]+ erwartet|help erwartet|kein Werkzeug dieses Vertrags|deutschen? Sätze?|deutscher Satz|bleibt deutsch' \
  docs/*.md | grep -v -e '54-refusals' -e '55-alte' -e 'README' -e 'PROJECT-STATE'
```

⇒ **73 Treffer in 27 Dateien.** Die `Sorte`-Spalte hat Stufe 1 vergeben:
**38 × V, 21 × B, 14 × A**. Die Zeilennummern sind der Stand **vor** dem
Eingriff; ein eingefügter Datumsvermerk verschiebt die folgenden Zeilen derselben
Datei.

| Datei:Zeile | Abschnitt | Zitat | Sorte |
|---|---|---|---|
| `03-mcp-browser-status.md:177` | Testing | \ | V |
| `03-mcp-browser-status.md:291` | Dev plan | unbekanntes `name` → `{content:[{type:"text",text:"Unbekanntes Tool: | B |
| `03-mcp-browser-status.md:294` | Dev plan | `"browser_status erwartet keine Argumente."`. `browser_status` → | B |
| `04-agenten-tab-und-navigate.md:134` | MCP-Werkzeug | **`ok:false` mit anderem Code**: `"Die Extension konnte die Anfrage nicht | V |
| `04-agenten-tab-und-navigate.md:201` | Testing | \ | V |
| `04-agenten-tab-und-navigate.md:202` | Testing | \ | V |
| `05-seiteninhalt-lesen.md:103` | Wire-Protokoll (neu: `read`) | **Kein Agenten-Tab** (nichts gespeichert, Tab weg, oder nicht mehr im | A |
| `05-seiteninhalt-lesen.md:394` | Dev plan | (`hasNoArguments` → sonst „browser_read erwartet keine Argumente."), | B |
| `06-klicken.md:78` | Wire-Protokoll (neu: `click`) | **Kein Agenten-Tab / Tab weg / Container**: `no_agent_tab` wie bei `read`. | A |
| `06-klicken.md:92` | MCP-Werkzeug | **unbekanntes Argument**: `isError` mit „browser_click erwartet nur `selector… | V |
| `06-klicken.md:94` | MCP-Werkzeug | **`invalid_selector`**: `isError`, „Der Selektor ist ungültig: <selektor>." | V |
| `06-klicken.md:95` | MCP-Werkzeug | **`no_match`**: `isError`, „Kein Element passt zu: <selektor>." | V |
| `06-klicken.md:96` | MCP-Werkzeug | **`not_clickable`**: `isError`, „Das Element ist nicht sichtbar oder deaktivi… | V |
| `06-klicken.md:98` | MCP-Werkzeug | `browser_read` („Kein Agenten-Tab — zuerst browser_navigate aufrufen."). | V |
| `06-klicken.md:103` | MCP-Werkzeug | „Die Extension konnte die Anfrage nicht ausführen (code=<code>)." — | V |
| `06-klicken.md:170` | Acceptance criteria | den deutschen Sätzen an (Beleg: `test/mcp.test.js`), und in allen drei Fällen | V |
| `06-klicken.md:305` | Dev plan | `UNEXPECTED_ARGUMENTS[BROWSER_CLICK] = "browser_click erwartet nur | B |
| `06-klicken.md:354` | Dev plan | **Der Selektor wird zitiert, wie er kommt** — in den deutschen Sätzen und, | V |
| `06-klicken.md:577` | Log | auf der Startseite ergab `isError` mit „Kein Element passt zu: | B |
| `07-tippen.md:152` | MCP-Werkzeug | **unbekanntes Argument**: `isError`, „browser_type erwartet nur `selector`, | V |
| `07-tippen.md:154` | MCP-Werkzeug | **`invalid_selector`**: `isError`, „Der Selektor ist ungültig: <selektor>." | V |
| `07-tippen.md:155` | MCP-Werkzeug | **`no_match`**: `isError`, „Kein Element passt zu: <selektor>." | V |
| `07-tippen.md:156` | MCP-Werkzeug | **`not_typeable`**: `isError`, „Das Element ist kein beschreibbares Feld oder | V |
| `07-tippen.md:158` | MCP-Werkzeug | **`password_not_allowed`**: `isError`, „Passwortfelder sind gesperrt. In den | V |
| `07-tippen.md:250` | Acceptance criteria | deutschen Sätzen an; in beiden Fällen wurde **kein** Wert gesetzt und kein | V |
| `08-fokus.md:57` | Wire-Protokoll (neu: `focus`) | **Kein Agenten-Tab** (nichts gespeichert, Tab weg, nicht mehr im | A |
| `08-fokus.md:85` | MCP-Werkzeug | **Argument übergeben**: `isError`, „browser_focus erwartet keine Argumente." | V |
| `09-dom-abfrage.md:105` | MCP-Werkzeug | **`invalid_selector`**: `isError`, „Der Selektor ist ungültig: <selektor>." | V |
| `09-dom-abfrage.md:109` | MCP-Werkzeug | liest): eigener Satz, „Der Parameter ist ungültig." — **ohne Feldnamen**, weil | V |
| `09-dom-abfrage.md:484` | Messlauf (Kriterium 6, 2026-10-23) | einem `navigate` antwortete `not_readable` („Diese Seite kann die Extension n… | B |
| `10-nicht-lesbar-mit-typ.md:10` |  | „Diese Seite kann die Extension nicht lesen (interne Seite oder Sonderformat)." | B |
| `10-nicht-lesbar-mit-typ.md:84` | MCP-Werkzeug | \ | V |
| `10-nicht-lesbar-mit-typ.md:86` | MCP-Werkzeug | \ | V |
| `10-nicht-lesbar-mit-typ.md:87` | MCP-Werkzeug | \ | V |
| `10-nicht-lesbar-mit-typ.md:187` | Messlauf (2026-10-23) | „Diese Seite kann die Extension nicht lesen **(Typ: pdf)**. Adresse: | B |
| `11-content-type-per-head.md:162` | Messlauf (Kriterium 2, 2026-10-23, live) | > Diese Seite kann die Extension nicht lesen **(Typ: pdf, Content-Type: appli… | B |
| `11-content-type-per-head.md:170` | Messlauf (Kriterium 2, 2026-10-23, live) | > Diese Seite kann die Extension nicht lesen **(Content-Type: application/pdf… | B |
| `13-page-busy.md:11` |  | „Diese Seite kann die Extension nicht lesen (interne Seite oder Sonderformat)", | B |
| `13-page-busy.md:31` | Ziel | \ | V |
| `13-page-busy.md:59` | Wire-Protokoll | {"ok":false,"error":{"code":"page_busy","message":"Die Seite lädt noch."}} | V |
| `13-page-busy.md:68` | MCP-Werkzeug | \ | V |
| `16-mehrere-agenten-tabs.md:82` | MCP-Werkzeug | Sätze: `too_many_tabs` ⇒ „Es sind schon fünf Agenten-Tabs offen — erst einen | V |
| `16-mehrere-agenten-tabs.md:468` | Messlauf (Kriterium 6, 2026-10-23, live) | antwortete „Es sind schon fünf Agenten-Tabs offen — erst einen schließen." | B |
| `17-slot-je-tab.md:118` | Messlauf (Kriterium 5, 2026-10-23, live) | („Die Extension konnte die Anfrage nicht ausführen (code=superseded)"), der z… | B |
| `19-browser-eval.md:221` | Extension | deutschen Sätze. | V |
| `19-browser-eval.md:407` | Dev plan | 3. **Ablehnung ohne Injektion — der Schalter zuerst, dann alles andere.** In … | B |
| `19-browser-eval.md:533` | Bekannte Lücken | statischen Satz; der Agent las „Der Code im Agenten-Tab ist gescheitert | B |
| `19-browser-eval.md:536` | Bekannte Lücken | Kriterium 6. Nach der Korrektur live: „Der Code im Agenten-Tab ist gescheitert: | B |
| `20-screenshot-teil-1.md:152` | Wire-Protokoll (neu: `screenshot`) | "message":"Das Bild ist auch nach dem Verkleinern zu groß: 611400 Bytes bei 1… | V |
| `20-screenshot-teil-1.md:202` | Extension | gekürzte Seitenmeldung), die deutschen Sätze. | V |
| `22-read-ausschnitte.md:324` | Dev plan | `UNEXPECTED_ARGUMENTS[BROWSER_READ]` (~335) ⇒ „browser_read erwartet nur | B |
| `24-frames.md:173` | Acceptance criteria | \ | V |
| `26-frame-click-type.md:231` | Messlauf | \ | B |
| `26-frame-click-type.md:235` | Messlauf | antwortete „Kein Element passt zu: input", während `browser_eval` im selben R… | B |
| `27-shadow-dom.md:143` | Acceptance criteria | \ | V |
| `30-prozess-und-konsole.md:560` | Risiken | **Konsolen-Encoding.** stderr trägt deutsche Sätze („Besitzer nicht ermittelb… | A |
| `31-youtube-recherche.md:99` | Die Messungen | „Das Element ist nicht sichtbar oder deaktiviert", `browser_inspect` zählt 0 | A |
| `32-transkript-werkzeug.md:354` | Dev plan | ein eigener Code und ein **eigener deutscher Satz in `extensionFailureText`** | V |
| `32-transkript-werkzeug.md:600` | Messlauf | \ | B |
| `32-transkript-werkzeug.md:602` | Messlauf | \ | B |
| `33-spurwahl.md:257` | Die Messungen | Player-Anzeige meldet „Untertitel: Englisch", **das Panel bleibt deutsch**. | A |
| `33-spurwahl.md:453` | Messlauf der ersten Fassung (Kriterium 9) — rot | \ | A |
| `33-spurwahl.md:1474` | Log | **Zwei sichtbare deutsche Sätze wurden umformuliert** („Untertitelspur" → | A |
| `33-spurwahl.md:1482` | Log | Neuladen —, das Panel bleibt deutsch mit identischen 19 777 Zeichen. | A |
| `38-rust-port.md:16` |  | inzwischen englisch. Wo diese Spec „deutsche Sätze" sagt (`## Ziel`, | A |
| `38-rust-port.md:26` | Ziel | deutschen Sätze aus `mcp.mjs` — **kopiert, nicht formuliert**; dieselben | A |
| `38-rust-port.md:82` | Das Inventar (aus dem Code gelesen, 2026-11-16) | \ | A |
| `38-rust-port.md:137` | Testing | die Testlandkarten-Zeile zu `mcp.rs` (durch den Nachtrag entschärft) | A |
| `38-rust-port.md:154` | Acceptance criteria | 4. **Die deutschen Sätze sind kopiert — die in Vergleich 2 gemessenen.** | A |
| `42-socket-im-tab.md:220` | Acceptance criteria | antwortet „Keine Extension verbunden". Binnen **10 s** (gewählt: `onRemoved` | V |
| `45-injection-naht.md:30` | Ziel | dieselben Fehlercodes, dieselben deutschen Sätze. | V |
| `48-eval-in-der-seitenwelt.md:184` | Log | \ | V |
| `50-await-in-eval.md:32` | Warum | Der Code im Agenten-Tab ist gescheitert: await is only valid in async functions | V |

### Zweite Klasse: die `description`-Zellen

Der Satz-Grep oben trifft die Beschreibungstabellen **nicht** — dort stand die
alte deutsche Beschreibung ohne einen der gesuchten Sätze. Eigener Befehl:

```
grep -rn '^| `description` |' docs/*.md | grep -v -e '54-' -e '55-' -e 'README' -e 'PROJECT-STATE'
```

⇒ **7 Treffer** (`docs/03:82`, `04:118`, `05:158`, `06:85`, `07:142`, `08:79`,
`09:96`). Dazu die alte `offset_out_of_range`-Meldung in `docs/22:91`, `:302`,
`:357`, `:528` — vier Zeilen, gebaut ist sie englisch
(`extension/bridge.js:2688`). Diese elf Zeilen waren **Sorte V**; alle elf tragen
jetzt die gebaute englische Fassung.

**Das ist eine Untergrenze, keine Obergrenze:** der Satz-Grep kann nur finden, was
er kennt. Vollständigkeit ist deshalb kein Kriterium dieser Spec, sondern eine
Lücke (siehe unten).

## Die Regel

Drei Sorten, drei Behandlungen. **`bleibt deutsch` allein ist kein Merkmal** — der
Satz stand in drei Bedeutungen im Baum (Werkzeugtext, Konsolenausgabe,
Seitensprache).

| Sorte | Merkmal | Behandlung |
|---|---|---|
| **V — Vertrag** | Kriterium, Vertragstabelle, Fehlertabelle, Aussagesatz über das Verhalten | korrigieren: der gebaute englische Satz oder der Zusatz „englisch seit `docs/54`" |
| **B — Beleg** | Zitat in `## Log`, `## Review`, einem datierten Nachtrag, einem datierten `## Messlauf …`, einem `## Warum` oder einer Zeile des `## Dev plan`, die beschreibt, was damals gebaut wurde | bleibt als Geschichte stehen, bekommt **einen** datierten Halbsatz: „(so die Antwort damals; englisch seit `docs/54`)" |
| **A — Ausschluss** | Betreiberkonsole, Betreiber-Oberfläche, Sprache der *Seite*, deutsches Fall-Etikett | unberührt |

`## Bekannte Lücken` ist ein Sonderfall: die Zeile beschreibt, was **jetzt** gilt,
also ist sie V, wenn sie einen deutschen Satz als gültig darstellt, sonst B.

**Ein deutsches Etikett ist kein Zitat.** „Kein Agenten-Tab / Tab weg / Container"
als Überschrift eines Testfalls ist Projektprosa und bleibt deutsch (Sorte A); erst
der Satz in Anführungszeichen ist ein Zitat.

Der Beleg wird nicht umgeschrieben: eine Spec, die ihre eigene Messung im Log
nachträglich verändert, verliert den Beweis (`docs/38` hat das Muster vorgegeben).

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `docs/55-alte-zitate-in-specs.md` | die Inventar-Tabelle | 73 Zeilen, 27 Dateien, jede Zeile mit Sorte V, B oder A (38/21/14) |
| `docs/03-mcp-browser-status.md` | `## MCP über stdio (der Vertrag)`, Kriterium 4 | kein deutscher Beispielsatz und keine deutsche `description` mehr (in `docs/54` erledigt) |
| `docs/05-seiteninhalt-lesen.md` | `## MCP-Werkzeug`, Kriterium 4 | dito |
| `docs/06-klicken.md`, `07-tippen.md`, `08-fokus.md`, `09-dom-abfrage.md`, `10-nicht-lesbar-mit-typ.md`, `13-page-busy.md`, `16-mehrere-agenten-tabs.md`, `19-browser-eval.md`, `20-screenshot-teil-1.md`, `32-transkript-werkzeug.md` | die Fehler- und Beispieltabellen | jeder `error:<code>` nennt den englischen Satz, der zum Code gehört |
| die Beleg-Zeilen (Sorte B) | `## Log`/`## Review`/`## Messlauf` | ein datierter Halbsatz, kein umgeschriebener Satz |

## Acceptance criteria

1. **Das Inventar ist reproduzierbar.** Der Satz-Befehl aus `## Das Inventar` ⇒ 73
   Treffer in 27 Dateien; die Tabelle hat 73 Zeilen; jede Zeile trägt V, B oder A.
   Die Zählung schneidet die Tabelle, nicht das Dokument:
   `sed -n '/^| Datei:Zeile |/,/^$/p' docs/55-alte-zitate-in-specs.md | grep -c '| V |'`
   ⇒ **38**, ebenso B ⇒ **21**, A ⇒ **14**; Summe **73**.
2. **Keine Vertragsstelle bleibt deutsch.** Der Satz-Befehl liefert nur noch die
   B- und A-Zeilen: `wc -l` ⇒ **35** (21 B + 14 A). Die zweite Klasse wird an den
   gebauten Konstanten gemessen, nicht am Suchmuster:
   `grep -rn '^| `description` |' docs/*.md | grep -v '54-\|55-' | grep -c '[äöüß]'`
   ⇒ **0**.
3. **Kein Code geändert.** `git status --porcelain -- . ':(exclude)docs' | wc -l`
   ⇒ **12** — und zwar genau die elf geänderten Dateien und der neue Wächter-Test
   aus `docs/54`; diese Spec fügt keine dreizehnte hinzu. (Ein noch nicht
   committeter Baum lässt sich nicht anders trennen; die Liste ist deshalb
   datiert und aufgezählt, nicht wegdefiniert.)
4. **Der Rest bleibt grün**, jedes Kommando einzeln:
   `npm run check` ⇒ 0; `npm test` ⇒ 547; `cargo test --manifest-path
   bridge-rs/Cargo.toml -- --test-threads=1` ⇒ 287; `bash scripts/parity.sh
   --impl rust --check` ⇒ 7/7.

## Dev plan

**Stufe 1 — die Sorte je Zeile**

Dateien: `docs/55-alte-zitate-in-specs.md`.

Jede der 73 Zeilen bekam V, B oder A; die Tabelle hat die Spalte `Sorte`.

Beweis: 73 Zeilen, drei Sorten, Summe 73 — `grep -c '| V |'` bzw. `'| B |'`,
`'| A |'`. **Abgeschlossen 2026-11-22**

**Stufe 2 — die Vertragsstellen**

Dateien: die 38 V-Zeilen und die zweite Klasse.

Jede Vertragsstelle nennt den gebauten englischen Satz; jede Fehlertabelle nennt
den Satz, der zum Code gehört.

Beweis: Kriterien 1 und 2. **Abgeschlossen 2026-11-22**

**Stufe 3 — die Belege, die Buchhaltung und der Status**

Dateien: die B-Dateien, `docs/README.md`, `docs/PROJECT-STATE.md`.

Jede Belegstelle trägt „(so die Antwort damals; englisch seit `docs/54`)". Die
Registry führt diese Spec; `PROJECT-STATE.md` verweist auf sie. Die letzte Stufe
stellt diese Spec auf `active` (`CONTRIBUTING.md` Schritt 7).

Beweis: Kriterien 2, 3 und 4. **Abgeschlossen 2026-11-22**

## Touch boundary

| erlaubt | nicht |
|---|---|
| `docs/*.md` — Zitate, Datumsvermerke, die `Sorte`-Spalte, `## Review`/`## Log` und der `status`-Wechsel auf `active` | jeder Code, jede Testdatei, jede Fixture |
| `docs/README.md`, `docs/PROJECT-STATE.md` | `docs/54-refusals-englisch.md` — dort ist die Abgrenzung fertig |

## Bekannte Lücken

- **Das Inventar ist ein `grep`, keine Leseprüfung.** Ein deutscher Satz ohne die
  gesuchten Wörter fehlt in der Tabelle; er ist deshalb auch nicht nachgezogen.
- **Die Trefferzahlen sind Untergrenzen.** Der Beleg-Anteil ist erst nach Stufe 1
  bekannt; und die zweite Klasse zeigt, dass ein Suchmuster nie vollständig ist.
- **Historische Zitate bleiben deutsch.** Sie tragen einen Datumsvermerk; ein
  umgeschriebenes Log wäre kein Beweis mehr.

## Open questions

**Keine.** Die Frage „markieren oder umschreiben?" hat der Betreiber mit der
Freigabe dieser Spec entschieden: markieren.

## Review

### Runde 1 — 2026-11-22 — `🔧 Fix these and I'll sign off` (mit Blockern)

Die Spec ist ein Neuschrieb nach dem `🤔 Needs a rethink` aus der `docs/54`-Runde
4; der Zähler beginnt mit dieser Fassung neu. **Am 2026-11-22 vom Betreiber auf
`active` gestellt.**

- **M1:** Kriterium 1 zählte die eigenen Beispielzeilen mit (der Tabellenschnitt
  fehlte).
- **M2:** das Inventar übersah die `description`-Zellen — zweite Befehlsklasse
  ergänzt.
- **M3:** `## Dev plan`, datierte `## Messlauf`-Abschnitte und `## Bekannte
  Lücken` waren in der Sortenregel nicht benannt.
- **M4:** der Amendments-Abschnitt behauptete Abdeckung, die die eigene Tabelle
  widerlegt.
- **M5:** die offene Frage war im selben Dokument schon beantwortet; die Regel
  stand als Vorschlag.
- **Minor:** Abschnittsnamen, Kriterium-2-Halbsatz, Kriterium 3, Touch boundary,
  „Ober-/Untergrenze", Review-Nummer, Testing-Zeilen, „drei Dateien".

## Log

- **2026-11-22, angelegt:** `docs/54` hat den Schnitt nach der dritten
  Review-Blockade geteilt. Die drei operativen Stellen hat `docs/54` selbst
  nachgezogen; alles Weitere stand hier. Grundlage ist der `grep` aus
  `## Das Inventar`: 73 Treffer in 27 Dateien.
- **2026-11-22, Review-Runde 1 von `docs/54` an dieser Spec:** die frühere
  Schätzung „29 Dateien, 95 Zeilen" war ohne Kommando; sie ist durch den
  Rohbefund ersetzt. Die Sorte je Zeile ist Stufe 1, nicht Annahme.
- **2026-11-22, Review Runde 1 dieser Fassung — alle Befunde übernommen:** die
  Zählung schneidet jetzt die Tabelle; die `description`-Zellen und die vier
  `offset`-Zeilen sind als zweite Klasse erfasst; die Sortenregel nennt Dev plan,
  Messlauf und Bekannte Lücken; die Amendments nennen die offenen Zeilen; die
  offene Frage und die Regel widersprechen sich nicht mehr; die Kleinigkeiten
  sind eingearbeitet.
- **2026-11-22, gebaut (alle drei Stufen):** Stufe 1 hat 73 Zeilen in 38 V, 21 B
  und 14 A sortiert. Stufe 2 hat die 38 V-Zeilen nachgezogen und die zweite
  Klasse (7 `description`-Zellen, 4 `offset`-Zeilen) auf Englisch umgestellt;
  drei deutsche Fall-Etiketten blieben als Projektprosa stehen (A). Stufe 3 hat
  die B-Zitate mit „(so die Antwort damals; englisch seit `docs/54`)" markiert,
  Registry und `PROJECT-STATE.md` nachgezogen und die Spec auf `active` gestellt.
- **2026-11-22, Abnahme:** `npm run check` ⇒ 0; `cargo test` 287 Fälle, `npm test`
  547 Fälle, `parity --check` 7/7 — unverändert, weil kein Code angefasst wurde.
  Kriterium 2: der Satz-Befehl liefert 35 Zeilen (21 B + 14 A); die
  `description`-Zeilen tragen keinen Umlaut.
