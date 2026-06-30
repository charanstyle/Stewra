#!/bin/bash
set -e

# PreToolUse hook for TypeScript safety checks
# Blocks Edit/Write/MultiEdit operations that contain:
# - 'any' types (STRICTLY FORBIDDEN)
# - Type assertions (as Type)
# - Angle bracket type casting (<Type>value)
# - Non-null assertions (!)

# Determine project directory with fallback
if [ -z "$CLAUDE_PROJECT_DIR" ]; then
    # Derive from script location: /path/to/project/.claude/hooks/script.sh -> /path/to/project
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    export CLAUDE_PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
fi

cd "$CLAUDE_PROJECT_DIR/.claude/hooks"
cat | npx tsx typescript-safety-checker.ts
