#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/_ensure-deps.sh"
cat | npx tsx typescript-antipattern-blocker.ts
exit $?
