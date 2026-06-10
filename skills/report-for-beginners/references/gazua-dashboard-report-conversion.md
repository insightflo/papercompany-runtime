# Gazua dashboard report conversion notes

Session pattern: converting an existing Gazua Markdown market report into a `report-for-beginners` HTML artifact for dashboard consumption.

## Source and target

- Source example: `reports/deep_dive/202606/Sector_Rotation_Analysis_2026-06-08.md`
- Target example: `reports/beginner_html/dashboard/deep_dive/202606/Sector_Rotation_Analysis_2026-06-08.html`

## Dashboard compatibility markers

When the HTML is intended for Gazua report viewer, keep or add:

```html
<html lang="ko" data-gazua-report="beginner-html" data-report-style="report-for-beginners">
<!-- GAZUA_BEGINNER_REPORT_META { ... "format":"beginner-html", "style":"report-for-beginners" } -->
```

The metadata should include at least: `schema`, `title`, `summary`, `category`, `market`, `published_at`, `read_time`, `source_path`, `format`.

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
