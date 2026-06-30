#!/bin/bash
# Skip if environment variable is set
if [ -n "$SKIP_ERROR_REMINDER" ]; then
    exit 0
fi
source "$(dirname "${BASH_SOURCE[0]}")/_ensure-deps.sh"
cat | npx tsx error-handling-reminder.ts
