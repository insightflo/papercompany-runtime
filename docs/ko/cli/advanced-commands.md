---
title: 고급 명령
summary: 플러그인, 워크트리, 컨텍스트 명령
---

플러그인 관리, 워크트리, 컨텍스트 프로필을 위한 고급 CLI 명령입니다.

## 플러그인 명령

컨트롤 플레인에 설치된 플러그인 관리:

```sh
# List installed plugins
pnpm paperclipai plugin list

# Install a plugin
pnpm paperclipai plugin install <source> [--version <v>]

# Uninstall a plugin
pnpm paperclipai plugin uninstall <plugin-id>

# Enable / disable
pnpm paperclipai plugin enable <plugin-id>
pnpm paperclipai plugin disable <plugin-id>

# Inspect a plugin
pnpm paperclipai plugin inspect <plugin-id>

# List example plugins
pnpm paperclipai plugin examples
```

## 워크트리 명령

격리된 에이전트 실행을 위한 git 워크트리 관리:

```sh
# Initialize worktree configuration
pnpm paperclipai worktree init [--path <path>]

# Create a worktree
pnpm paperclipai worktree make <name> [--base <ref>] [--path <path>]

# Print worktree environment for the current directory
pnpm paperclipai worktree env [--json]

# List worktrees
pnpm paperclipai worktree list [--json]

# Show merge history
pnpm paperclipai worktree merge-history <name>

# Clean up merged/stale worktrees
pnpm paperclipai worktree cleanup [--dry-run]
```

## 컨텍스트 명령

컨텍스트 프로필은 플래그를 반복하지 않도록 기본값을 저장합니다:

```sh
# Set a context default
pnpm paperclipai context set --api-base http://localhost:3200 --company-id <id>

# Set a profile
pnpm paperclipai context set --profile ops --api-base http://localhost:3200

# Show the current context
pnpm paperclipai context show

# List profiles
pnpm paperclipai context list [--json]

# Use a profile
pnpm paperclipai context use <profile>

# Use a context file directly
pnpm paperclipai context use <path-to-context.json>
```

컨텍스트에 시크릿을 저장하지 않으려면 env var 참조를 사용하세요:

```sh
pnpm paperclipai context set --api-key-env-var-name PAPERCLIP_API_KEY
export PAPERCLIP_API_KEY=...
```

컨텍스트는 `~/.paperclip/context.json`에 저장됩니다.
