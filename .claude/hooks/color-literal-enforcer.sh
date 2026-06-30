#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/_ensure-deps.sh"
cat | npx tsx color-literal-enforcer.ts
exit $?
