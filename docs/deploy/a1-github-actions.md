# A1 GitHub Actions Deployment

This repository deploys A1 Papercompany from GitHub Actions by SSHing into the
A1 host and running the same deploy script that can be run manually on the host.

The deployment is intentionally server-side:

1. GitHub Actions verifies the commit with typecheck, deployment smoke tests, and build.
2. GitHub Actions copies `scripts/deploy-a1.sh` to A1.
3. A1 fast-forwards `/srv/papercompany/papercompany-runtime` to the verified commit.
4. A1 runs `pnpm install --frozen-lockfile` and `pnpm build`.
5. A1 restarts `papercompany-runtime.service`.
6. A1 checks the internal and public health endpoints.

Running `pnpm build` on A1 includes the UI build because the workspace build runs
the `@paperclipai/ui` package build.

## Required GitHub Secrets

Set these repository secrets before enabling the workflow:

- `A1_SSH_HOST`: A1 host or IP address.
- `A1_SSH_USER`: SSH user, currently expected to be `opc`.
- `A1_SSH_PRIVATE_KEY`: private key allowed to SSH into A1.

The A1 user must be able to run this without an interactive password prompt:

```sh
sudo -n systemctl restart papercompany-runtime.service
```

## Optional GitHub Variables

These repository variables can override the production defaults:

- `A1_LEGACY_DEPLOY_ENABLED`: defaults to enabled when unset. Set to `false`
  only when the Operations-owned, Human Operator-approved deployment path is
  ready. The `verify` job continues to run so the exact `main` commit can still
  satisfy the approval gate; only the legacy SSH deployment job is skipped.
- `A1_SSH_PORT`: default `22`
- `A1_DEPLOY_PATH`: default `/srv/papercompany/papercompany-runtime`
- `A1_SERVICE_NAME`: default `papercompany-runtime.service`
- `A1_INTERNAL_HEALTH_URL`: default `http://127.0.0.1:3100/api/health`
- `A1_PUBLIC_HEALTH_URL`: default `https://papercompany.showk.ing/api/health`
- `A1_HEALTH_TIMEOUT_SECONDS`: default `120`
- `A1_HEALTH_INTERVAL_SECONDS`: default `3`

## A1 Host Requirements

The deploy path must be a clean git checkout with an `origin` remote that can
fetch `main`. The A1 host also needs:

- `git`
- `pnpm`
- `curl`
- `systemctl`
- `flock`

If the checkout has local changes, deployment stops before pulling.
