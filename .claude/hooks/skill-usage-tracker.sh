#!/bin/bash
set -e

# PostToolUse hook that tracks Skill tool usage to create session markers
# This prevents guardrail hooks from re-blocking after a skill has been activated

# Determine project directory with fallback
if [ -z "$CLAUDE_PROJECT_DIR" ]; then
    # Derive from script location: /path/to/project/.claude/hooks/script.sh -> /path/to/project
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    CLAUDE_PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
    export CLAUDE_PROJECT_DIR
fi

cd "$CLAUDE_PROJECT_DIR/.claude/hooks"
# Pass stdin directly to the TypeScript implementation
cat | npx tsx skill-usage-tracker.ts
