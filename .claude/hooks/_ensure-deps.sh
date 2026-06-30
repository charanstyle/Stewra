#!/bin/bash
# Shared helper: ensures hooks node_modules is installed before running tsx.
# Source this from any hook shell wrapper:
#   source "$(dirname "${BASH_SOURCE[0]}")/_ensure-deps.sh"

# Determine project directory with fallback
if [ -z "$CLAUDE_PROJECT_DIR" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    CLAUDE_PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
fi
# Export so child processes (npx tsx) inherit the value
export CLAUDE_PROJECT_DIR

HOOKS_DIR="$CLAUDE_PROJECT_DIR/.claude/hooks"

# Auto-install if tsx is not available locally
if [ ! -x "$HOOKS_DIR/node_modules/.bin/tsx" ]; then
    (cd "$HOOKS_DIR" && npm install --silent --no-audit --no-fund 2>/dev/null) || true
fi

cd "$HOOKS_DIR"
