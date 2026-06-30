#!/bin/bash

# Read stdin (required - hooks pipe data via stdin)
HOOK_INPUT=$(cat)

# Debug logging (only when CLAUDE_HOOK_DEBUG is set)
if [ -n "$CLAUDE_HOOK_DEBUG" ]; then
    DEBUG_LOG="$CLAUDE_PROJECT_DIR/.claude/tsc-cache/hook-debug.log"
    mkdir -p "$(dirname "$DEBUG_LOG")"
    echo "Hook triggered at $(date)" >> "$DEBUG_LOG"
    echo "CLAUDE_PROJECT_DIR: $CLAUDE_PROJECT_DIR" >> "$DEBUG_LOG"
    echo "Current working directory: $(pwd)" >> "$DEBUG_LOG"
fi

# Define the service directories to check
services_dirs=("backend" "frontend" "website")
services_with_changes=()

# Change to project root for git operations (monorepo support)
cd "$CLAUDE_PROJECT_DIR"

# Check if this is a git repository (either at root or parent)
if [ -d ".git" ] || git rev-parse --git-dir > /dev/null 2>&1; then
    echo "  -> Monorepo detected at project root" >> "${DEBUG_LOG:-/dev/null}"

    # Get all changed files from the monorepo root
    git_status=$(git status --porcelain 2>/dev/null)

    if [ -n "$git_status" ]; then
        echo "  -> Git changes found:" >> "${DEBUG_LOG:-/dev/null}"
        echo "$git_status" | sed 's/^/    /' >> "${DEBUG_LOG:-/dev/null}"

        # Check which services have changes
        for service in "${services_dirs[@]}"; do
            # Filter changes for this service directory
            service_changes=$(echo "$git_status" | grep -E "^.{2,3}${service}/" 2>/dev/null)

            if [ -n "$service_changes" ]; then
                echo "  -> $service has changes" >> "${DEBUG_LOG:-/dev/null}"
                services_with_changes+=("$service")
            fi
        done
    else
        echo "  -> No git changes" >> "${DEBUG_LOG:-/dev/null}"
    fi
else
    echo "  -> Not a git repository" >> "${DEBUG_LOG:-/dev/null}"
fi

echo "Services with changes: ${services_with_changes[@]}" >> "${DEBUG_LOG:-/dev/null}"

if [[ ${#services_with_changes[@]} -gt 0 ]]; then
    services_list=$(IFS=', '; echo "${services_with_changes[*]}")
    echo "Changes detected in: $services_list" >> "${DEBUG_LOG:-/dev/null}"

    # Display helpful message to user
    cat >&2 <<EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔧 UNCOMMITTED CHANGES DETECTED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Services with changes: ${services_list}

💡 SUGGESTED ACTION:
To build and fix any errors in these services, you can:

1. Resume this session and ask Claude to:
   "Build and fix any errors in: ${services_list}"

2. Or use the Task tool with a general-purpose agent:
   Task(subagent_type='general-purpose', description='Fix build errors', prompt='Build and fix errors in: ${services_list}')

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

EOF
else
    echo "No services with changes detected — no action needed." >> "${DEBUG_LOG:-/dev/null}"
fi

echo "=== END DEBUG SECTION ===" >> "${DEBUG_LOG:-/dev/null}"
exit 0