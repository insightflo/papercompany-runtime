#!/usr/bin/env bash
# setup-agent-config.sh — Create isolated Claude config directory for agents
# Usage: bash scripts/setup-agent-config.sh <agent-id> <config-dir>
#
# This script creates an isolated CLAUDE_CONFIG_DIR for a specific agent,
# preventing them from sharing global Claude hooks and settings.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

usage() {
    echo "Usage: $0 <agent-id> <config-dir>"
    echo
    echo "Arguments:"
    echo "  agent-id     Agent identifier (e.g., 'agent-001')"
    echo "  config-dir   Target config directory path (absolute or relative to project root)"
    echo
    echo "Example:"
    echo "  $0 agent-001 /tmp/claude-agent-001"
    exit 1
}

# Validate arguments
if [ $# -lt 2 ]; then
    usage
fi

AGENT_ID="$1"
CONFIG_DIR="$2"

# Convert relative path to absolute
if [[ ! "$CONFIG_DIR" = /* ]]; then
    CONFIG_DIR="$PROJECT_ROOT/$CONFIG_DIR"
fi

echo "======================================"
echo "Agent Config Setup"
echo "======================================"
echo "Agent ID: $AGENT_ID"
echo "Config Dir: $CONFIG_DIR"
echo

# Create config directory structure
echo "Creating config directory structure..."
mkdir -p "$CONFIG_DIR/skills"
mkdir -p "$CONFIG_DIR/hooks"
mkdir -p "$CONFIG_DIR/.global"

# Create minimal settings.json if it doesn't exist
SETTINGS_FILE="$CONFIG_DIR/settings.json"
if [ ! -f "$SETTINGS_FILE" ]; then
    echo "Creating minimal settings.json..."
    cat > "$SETTINGS_FILE" <<EOF
{
  "appId": "papercompany-agent",
  "agentId": "$AGENT_ID"
}
EOF
else
    echo "settings.json already exists, skipping..."
fi

# Create README in config dir
README_FILE="$CONFIG_DIR/README.md"
cat > "$README_FILE" <<EOF
# Claude Config Directory for $AGENT_ID

This directory contains the isolated Claude configuration for agent \`$AGENT_ID\`.

## Purpose

This isolation prevents the agent from:
- Accessing global Claude hooks from the user's ~/.claude/
- Modifying global settings that affect other agents
- Interfering with other agents' skill installations

## Structure

- \`settings.json\` — Agent-specific Claude settings
- \`skills/\` — Agent-specific skill installations (symlinks created at runtime)
- \`hooks/\` — Agent-specific hook scripts (optional)
- \`.global/\` — Global state managed by Claude

## Adapter Integration

The \`claude-local\` adapter passes this directory via the \`CLAUDE_CONFIG_DIR\` environment variable when executing the agent.

## DO NOT modify manually

This directory is managed by the papercompany runtime. Manual modifications may be overwritten.
EOF

echo
echo -e "${GREEN}✓${NC} Agent config directory created successfully"
echo
echo "Next steps:"
echo "1. Update the agent's adapter_config to include:"
echo "   claudeConfigDir: \"$CONFIG_DIR\""
echo "2. Restart the agent for changes to take effect"
