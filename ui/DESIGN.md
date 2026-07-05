# Paperclip UI Design System

## 1. Atmosphere & Identity

Paperclip is a quiet control plane for operators supervising agent work. The signature is dense evidence with restrained borders: pages should make status, ownership, and next action scannable without decorative panels or marketing composition.

## 2. Color

| Role | Token | Light | Dark | Usage |
|------|-------|-------|------|-------|
| Background | `--background` | `oklch(1 0 0)` | `oklch(0.145 0 0)` | Page and shell background |
| Foreground | `--foreground` | `oklch(0.145 0 0)` | `oklch(0.985 0 0)` | Primary text |
| Card | `--card` | `oklch(1 0 0)` | `oklch(0.205 0 0)` | Tool panels and repeated items |
| Muted | `--muted` | `oklch(0.97 0 0)` | `oklch(0.269 0 0)` | Secondary surfaces |
| Muted text | `--muted-foreground` | `oklch(0.556 0 0)` | `oklch(0.708 0 0)` | Captions and metadata |
| Border | `--border` | `oklch(0.922 0 0)` | `oklch(0.269 0 0)` | Dividers and panels |
| Accent | `--accent` | `oklch(0.97 0 0)` | `oklch(0.269 0 0)` | Hover and selected nav states |
| Destructive | `--destructive` | `oklch(0.577 0.245 27.325)` | `oklch(0.637 0.237 25.331)` | Failed or blocked states |

Use existing semantic Tailwind tokens (`bg-background`, `text-muted-foreground`, `border-border`) instead of raw colors.

## 3. Typography

Primary font is the system sans stack through Tailwind defaults. Use `text-sm` for body rows, `text-xs` for metadata and overlines, `text-xl` for compact page headings, and `font-semibold` only for key labels. Letter spacing stays default except existing uppercase overlines.

## 4. Spacing & Layout

Spacing follows a 4px base through Tailwind tokens. Operational pages use `space-y-4` or `space-y-6`, compact rows use `gap-2` or `gap-3`, and content should remain full-width inside the app shell. Prefer grids and tables that collapse to stacked rows on mobile.

## 5. Components

### Sidebar Item
- Structure: icon, one-line label, optional badge.
- States: default muted text, hover `bg-accent/50`, active `bg-accent`.
- Accessibility: real links/buttons with readable labels.

### Evidence Row
- Structure: title, summary, metadata, optional action link.
- States: default border row, hover only when clickable, empty state through `EmptyState`.
- Accessibility: preserve text wrapping and provide explicit links for navigation.

### Status Badge
- Structure: compact text token using existing status colors.
- States: informational, attention, blocked, failed, completed.
- Accessibility: do not rely on color alone; include visible status text.

## 6. Motion & Interaction

Use existing button/link transitions only. Do not add decorative motion. Loading uses existing skeletons or muted text.

## 7. Depth & Surface

Depth strategy is borders-only. Use `border border-border` and occasional `bg-muted/30`; avoid shadows, nested cards, and decorative gradients.
