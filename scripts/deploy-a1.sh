#!/usr/bin/env bash
# Compatibility entrypoint: refuse before any external command or filesystem write.
printf '%s\n' \
  '[deploy-a1] ERROR: Legacy A1 restart deployment is retired.' \
  'Safe runtime drain is not implemented; this script cannot deploy safely.' \
  'Do not force or retry this path. See doc/DEPLOYMENT-SAFETY.md for operator guidance.' >&2
exit 1
