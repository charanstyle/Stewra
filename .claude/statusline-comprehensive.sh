#!/bin/bash

# Read JSON input from stdin
input=$(cat)

# ── Extract ALL fields in a single jq call ───────────────────────────
eval "$(echo "$input" | jq -r '
  @sh "session_id=\(.session_id // "")",
  @sh "session_name=\(.session_name // "")",
  @sh "model_id=\(.model.id // "")",
  @sh "model_display=\(.model.display_name // "Unknown")",
  @sh "current_dir=\(.workspace.current_dir // .cwd // "")",
  @sh "project_dir=\(.workspace.project_dir // "")",
  @sh "added_dirs=\(.workspace.added_dirs // [] | join(", "))",
  @sh "version=\(.version // "")",
  @sh "output_style=\(.output_style.name // "default")",
  @sh "used_pct=\(.context_window.used_percentage // "")",
  @sh "remaining_pct=\(.context_window.remaining_percentage // "")",
  @sh "ctx_size=\(.context_window.context_window_size // "")",
  @sh "total_in=\(.context_window.total_input_tokens // "")",
  @sh "total_out=\(.context_window.total_output_tokens // "")",
  @sh "cache_write=\(.context_window.current_usage.cache_creation_input_tokens // "")",
  @sh "cache_read=\(.context_window.current_usage.cache_read_input_tokens // "")",
  @sh "vim_mode=\(.vim.mode // "")",
  @sh "agent_name=\(.agent.name // "")",
  @sh "agent_type=\(.agent.type // "")",
  @sh "wt_name=\(.worktree.name // "")",
  @sh "wt_path=\(.worktree.path // "")",
  @sh "wt_branch=\(.worktree.branch // "")"
' 2>/dev/null)"

# ── Colors ────────────────────────────────────────────────────────────
RST="\033[0m"
BOLD="\033[1m"
DIM="\033[2m"

GREEN="\033[32m"
YELLOW="\033[33m"
BLUE="\033[34m"
MAGENTA="\033[35m"
CYAN="\033[36m"

BR_BLUE="\033[94m"
BR_CYAN="\033[96m"
BR_GREEN="\033[92m"
BR_MAGENTA="\033[95m"
BR_RED="\033[91m"
BR_YELLOW="\033[93m"
GRAY="\033[90m"

# ── System info (avoid subshells) ────────────────────────────────────
user="${USER:-unknown}"
hostname="${HOSTNAME%%.*}"
# Single date call with combined format
read -r timestamp date_info <<< "$(date '+%H:%M:%S %a %b %d, %Y')"

# ── Working directory ─────────────────────────────────────────────────
cwd="${current_dir:-$PWD}"
if [ -n "$project_dir" ] && [[ "$cwd" == "$project_dir"* ]]; then
    relative_path="${cwd#$project_dir}"
    display_dir="${relative_path:-/}"
else
    display_dir="${cwd##*/}"
fi
project_name="${project_dir##*/}"

# ── Git info (branch only from HEAD file - no git commands) ──────────
git_segment=""
git_dir=""
if [ -f "$cwd/.git/HEAD" ]; then
    git_dir="$cwd/.git"
elif [ -f "$project_dir/.git/HEAD" ]; then
    git_dir="$project_dir/.git"
fi

if [ -n "$git_dir" ]; then
    head_content=$(<"$git_dir/HEAD")
    if [[ "$head_content" == ref:* ]]; then
        branch="${head_content#ref: refs/heads/}"
    else
        branch="${head_content:0:8}"
    fi
    git_segment="${GREEN}${branch}${RST}"
else
    git_segment="${GRAY}no git${RST}"
fi

# ── Context window bar ────────────────────────────────────────────────
ctx_segment=""
if [ -n "$used_pct" ] && [ -n "$remaining_pct" ]; then
    used_int=${used_pct%.*}

    if [ "$used_int" -ge 80 ]; then
        ctx_color="${BR_RED}"
    elif [ "$used_int" -ge 50 ]; then
        ctx_color="${BR_YELLOW}"
    else
        ctx_color="${BR_GREEN}"
    fi

    # Visual bar (10 chars wide) - built inline without loop
    filled=$((used_int / 10))
    bar="##########"
    bar="${bar:0:$filled}----------"
    bar="${bar:0:10}"

    ctx_segment="${ctx_color}[${bar}] ${used_pct%.*}%${RST}"
fi

# ── Token details (inline formatting, no subshells) ──────────────────
format_k() {
    local n="$1"
    if [ -z "$n" ] || [ "$n" = "null" ]; then REPLY=""; return; fi
    if [ "$n" -ge 1000 ] 2>/dev/null; then
        REPLY="$((n / 1000))K"
    else
        REPLY="$n"
    fi
}

token_segment=""
if [ -n "$total_in" ] && [ "$total_in" != "null" ]; then
    format_k "$total_in"; t_in="$REPLY"
    format_k "$total_out"; t_out="$REPLY"
    token_segment="${CYAN}in:${t_in}${RST} ${MAGENTA}out:${t_out}${RST}"
fi

cache_segment=""
if [ -n "$cache_write" ] && [ "$cache_write" != "null" ] && [ "$cache_write" != "0" ]; then
    format_k "$cache_write"; cw="$REPLY"
    format_k "$cache_read"; cr="$REPLY"
    cache_segment="${DIM}${CYAN}cache w:${cw} r:${cr}${RST}"
fi

ctx_size_segment=""
if [ -n "$ctx_size" ] && [ "$ctx_size" != "null" ]; then
    format_k "$ctx_size"; cs="$REPLY"
    ctx_size_segment="${GRAY}window:${cs}${RST}"
fi

# ── Optional segments ─────────────────────────────────────────────────
session_segment=""
[ -n "$session_name" ] && session_segment="${BR_CYAN}${session_name}${RST}"

session_id_short=""
[ -n "$session_id" ] && session_id_short="${GRAY}${session_id:0:8}${RST}"

vim_segment=""
if [ -n "$vim_mode" ]; then
    if [ "$vim_mode" = "INSERT" ]; then
        vim_segment="${BR_GREEN}VIM:INSERT${RST}"
    else
        vim_segment="${BR_YELLOW}VIM:NORMAL${RST}"
    fi
fi

agent_segment=""
if [ -n "$agent_name" ]; then
    agent_segment="${BR_MAGENTA}agent:${agent_name}${RST}"
    [ -n "$agent_type" ] && agent_segment="${agent_segment}${DIM}(${agent_type})${RST}"
fi

wt_segment=""
if [ -n "$wt_name" ]; then
    wt_segment="${BR_BLUE}wt:${wt_name}${RST}"
    [ -n "$wt_branch" ] && wt_segment="${wt_segment}${DIM}@${wt_branch}${RST}"
fi

added_segment=""
[ -n "$added_dirs" ] && added_segment="${GRAY}+dirs:${added_dirs}${RST}"

model_id_short=""
[ -n "$model_id" ] && model_id_short="${GRAY}(${model_id})${RST}"

# ── Separator ─────────────────────────────────────────────────────────
SEP="${GRAY} | ${RST}"

# ── Build lines ───────────────────────────────────────────────────────

# Line 1: User/Host + Project + Dir + Git
line1="${BOLD}${CYAN}${user}@${hostname}${RST}"
line1="${line1}${SEP}${BR_BLUE}${project_name}${RST}${BLUE}:${display_dir}${RST}"
line1="${line1}${SEP}${git_segment}"

# Line 2: Model + Style + Context bar + Tokens
line2="${BOLD}${GREEN}${model_display}${RST} ${model_id_short}"
line2="${line2}${SEP}${YELLOW}style:${output_style}${RST}"
[ -n "$ctx_segment" ] && line2="${line2}${SEP}${ctx_segment}"
[ -n "$token_segment" ] && line2="${line2}${SEP}${token_segment}"

# Line 3: Time + Version + Session + Vim + Agent + Worktree + Cache + Window size
line3="${BR_YELLOW}${timestamp}${RST} ${GRAY}${date_info}${RST}"
line3="${line3}${SEP}${GRAY}v${version}${RST}"

[ -n "$session_segment" ] && line3="${line3}${SEP}${session_segment}"
[ -n "$session_id_short" ] && line3="${line3} ${session_id_short}"
[ -n "$vim_segment" ] && line3="${line3}${SEP}${vim_segment}"
[ -n "$agent_segment" ] && line3="${line3}${SEP}${agent_segment}"
[ -n "$wt_segment" ] && line3="${line3}${SEP}${wt_segment}"
[ -n "$cache_segment" ] && line3="${line3}${SEP}${cache_segment}"
[ -n "$ctx_size_segment" ] && line3="${line3}${SEP}${ctx_size_segment}"
[ -n "$added_segment" ] && line3="${line3}${SEP}${added_segment}"

# ── Output ────────────────────────────────────────────────────────────
printf "%b\n%b\n%b" "$line1" "$line2" "$line3"
