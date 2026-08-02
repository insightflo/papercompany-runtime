# adapter-commandcode-local

## 0.1.0

- Initial Command Code (`cmd`) local adapter for papercompany.
- Headless `-p`/`--print` runs with `--output-format json` NDJSON parsing.
- Configurable model (`--model`), reasoning effort (`--effort`), and per-run turn cap.
- Automation-safe flags: `--skip-onboarding`, `--permission-mode auto-accept`, `--trust`, `--no-auto-update`.
- Optional session resume via `--resume <id>` with defensive stale-session recovery.
- `--list-models` model discovery with caching.
- Operator-overridable executable via `command` adapter config (defaults to `cmd`).
