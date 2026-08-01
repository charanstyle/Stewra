# load-env.sh — read the repo-root .env.e2e (dotenv format) and export its variables.
#
# Sourced by the Maestro wrappers; not executable on its own.
#
# Why not `set -a; source .env.e2e`: .env.e2e is a *dotenv* file, shared verbatim with the
# Playwright web suite which parses it with dotenv. Shell `source` EXECUTES it, so any unquoted
# value containing spaces — e.g. `E2E_CONTACT_NAME=QA Web B`, which dotenv reads correctly as
# "QA Web B" — becomes an assignment plus a command, and the wrapper died with
# `.env.e2e: line 9: Web: command not found` before it ever reached the flow. Sourcing also lets a
# stray line in a secrets file run arbitrary code. This parses instead of executing, so both suites
# read the same file the same way.
#
# Real environment variables win over the file, matching the web suite's documented behaviour, so CI
# can inject the same names without a file present.
#
# Format read: `KEY=VALUE`, one per line; blank lines and `#` comments skipped; an optional `export `
# prefix tolerated; one layer of matching single or double quotes stripped. An unquoted value is
# taken literally to end of line (with trailing whitespace trimmed) — quote any value that needs to
# contain a `#`.

# load_env_file <path> — export every KEY=VALUE pair in <path>. The caller is responsible for
# checking the file exists and for asserting the specific variables it requires.
load_env_file() {
  local file="$1" line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"                        # tolerate CRLF-saved files
    line="${line#"${line%%[![:space:]]*}"}"     # trim leading whitespace
    [[ -z "$line" || "$line" == '#'* ]] && continue
    [[ "$line" == 'export '* ]] && line="${line#export }"
    [[ "$line" == *=* ]] || continue

    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"        # trim trailing whitespace off the key
    # Anything that isn't a shell-legal name is not a variable line (e.g. a wrapped comment
    # containing "="); skipping it is what keeps prose in the file from becoming a bad export.
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue

    if [[ ${#value} -ge 2 && "$value" == '"'*'"' ]]; then
      value="${value:1:${#value}-2}"
    elif [[ ${#value} -ge 2 && "$value" == "'"*"'" ]]; then
      value="${value:1:${#value}-2}"
    else
      value="${value%"${value##*[![:space:]]}"}"  # unquoted: trim trailing whitespace
    fi

    # Already set in the real environment → leave it alone (env beats file).
    [[ -n "${!key+x}" ]] && continue
    export "${key}=${value}"
  done < "$file"
}
