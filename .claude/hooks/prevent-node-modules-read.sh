#!/bin/bash
set -e
source "$(dirname "${BASH_SOURCE[0]}")/_ensure-deps.sh"
cat | npx tsx prevent-node-modules-read.ts
