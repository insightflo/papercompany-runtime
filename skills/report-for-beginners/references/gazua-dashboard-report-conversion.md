# Gazua dashboard report conversion notes

Session pattern: converting an existing Gazua Markdown market report into a `report-for-beginners` HTML artifact for dashboard consumption.

## Source and target

- Source example pattern: Gazua deep-dive markdown under `reports/deep_dive/<YYYYMM>/`.
- Target example pattern: beginner HTML under `reports/beginner_html/dashboard/deep_dive/<YYYYMM>/`.

## Dashboard compatibility markers

When the HTML is intended for Gazua report viewer, keep or add:

```html
<html lang="ko" data-gazua-report="beginner-html" data-report-style="report-for-beginners" data-renderer="gazua-report-for-beginners" data-template-signature="...">
<!-- GAZUA_BEGINNER_REPORT_META { ... "format":"beginner-html", "style":"report-for-beginners", "renderer":"gazua-report-for-beginners", "renderer_version":"...", "template_signature":"..." } -->
```

The metadata should include at least: `schema`, `title`, `summary`, `category`, `market`, `published_at`, `read_time`, `source_path`, `format`, `style`, `renderer`, `renderer_version`, `template_signature`.

## Fixed renderer contract

Gazua dashboard-bound HTML must be produced by the Gazua renderer, not hand-authored per run:

```sh
python scripts/reports/migrate_gazua_reports_to_beginner_html.py --name-contains Narrative_Deep_Dive_YYYY-MM-DD --market KR
python scripts/reports/qa_report_for_beginners_html.py reports/beginner_html/dashboard/deep_dive/YYYYMM/Narrative_Deep_Dive_YYYY-MM-DD.html
```

The agent still authors the source report and can rewrite weak source markdown first. The renderer owns the HTML shell, CSS, metadata, and template signature so reports remain visually consistent. QA must fail any dashboard HTML missing `data-renderer="gazua-report-for-beginners"` or the renderer `template_signature`.

## Report-for-beginners structure that worked

For a market rotation report, use:

1. Header with scope, date, confidence legend
2. Core summary with verdict table and KPI cards
3. Evidence/data-adjustment section explaining stale or conflicting signals
4. Calculation section with reproducible math and a CSS chart
5. Sector-by-sector analysis with beginner explanation blocks
6. Risk register and holdings/action table
7. 2–4 week scenarios
8. Conditional conclusion, prioritized actions, monitoring dashboard
9. References

## Important pitfall: conflicting numbers

If the source has a numeric inconsistency, do not silently copy it as fact. Example encountered:

- Source text said `22.2% advance ratio = 614/1970`.
- Actual calculation: `614 ÷ 1970 = 31.17%`.
- The HTML kept the source's final breadth value (`22.2%`) but explicitly noted that the raw fraction differs and may reflect filtered breadth logic.

Pattern: preserve source conclusions when they are the report's canonical signal, but surface calculation mismatch in the calculation/evidence section.

## Verification checklist

Run/perform checks before saying done:

- File starts with `<!DOCTYPE html>` and ends with `</html>`.
- Contains `data-gazua-report="beginner-html"` when dashboard-bound.
- Contains `data-report-style="report-for-beginners"` for traceability.
- Contains `GAZUA_BEGINNER_REPORT_META` when dashboard-bound.
- Includes verdict table, KPI grid, evidence table, calculation list, chart card, risk grid, scenario grid, references, and footnote refs.
- No raw Markdown heading prefixes remain (`^# ` in rendered HTML file content).
- Browser-open the local file or dashboard viewer and visually inspect: readable header, tables/cards fit, no raw markdown visible, no broken layout.
