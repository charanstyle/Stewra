#!/bin/bash
set -e
source "$(dirname "${BASH_SOURCE[0]}")/../_ensure-deps.sh"
cd "$CLAUDE_PROJECT_DIR/.claude/hooks/PostToolUse"
cat | npx tsx track-skill-usage.ts
