#!/usr/bin/env node
/**
 * fallback-scan — audit the repo for configuration defaults that GUESS A TARGET.
 *
 * The rule: a setting naming *where* something goes — a host, a URL, a container, a mailbox, a
 * database — must be required, and its absence must fail loudly at boot. `env.SSH_HOST || 'home'`
 * does not make the code robust; it turns a missing setting into a run that quietly targets the
 * wrong machine, and every error after that describes the wrong system.
 *
 * This is a REPO-WIDE AUDIT, not a hook. The write-time blocking is done by the machine-global
 * PreToolUse guard, which is stricter (it also catches error-swallowing and sentinel returns) but
 * is stdin-only and never sees a file nobody is editing. This covers the two gaps that matter
 * here: it sweeps every tracked file, and it reads shell/compose `${VAR:-default}`, which the
 * global guard does not. Deliberately self-contained — a repo script must not depend on one
 * developer's machine configuration.
 *
 *   node scripts/fallback-scan.mjs        # exit 1 if any error-level finding
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** Env reads defaulted to a string literal: process.env.X, import.meta.env.X, env.X, cfg.env.X. */
const ENV_DEFAULT =
  /(?:process\.env|import\.meta\.env|\benv)\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([^'"]+)['"]\s*\])\s*(?:\|\||\?\?)\s*(['"`])([^'"`]*)\3/g;

/** Shell/compose `${VAR:-default}` with a non-empty default. */
const SHELL_DEFAULT = /\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]+)\}/g;

/** Variable names that name a destination rather than a tunable. */
const TARGET_NAME =
  /(HOST|URL|URI|ENDPOINT|CONTAINER|MAILBOX|MAIL|SMTP|DATABASE|_DB|DB_|DSN|ADDR|ADDRESS|SERVER|BUCKET|REGION|ORIGIN|DOMAIN|ACCOUNT|TENANT|PROJECT|CLUSTER|NAMESPACE|PATH|DIR|BIN|KEY|SECRET|TOKEN|PASSWORD|USER)/i;

/**
 * Conventional sinks and scratch locations. `>> "${DEBUG_LOG:-/dev/null}"` is not a guess about
 * where logs go — it is the idiomatic spelling of "discard unless someone asked for a file".
 */
const NON_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/tmp', '.', './', '/']);

/**
 * `.mts`/`.cts` are ordinary TypeScript and are included deliberately: the global guard skips them,
 * so leaving them out here left `bridge/src/main/ipc.cts` — production Electron main-process code —
 * covered by no scanner at all.
 */
const SCANNABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sh|bash|ya?ml)$/;

/** Values that look like a destination: a URL, a hostname, an absolute path, an email, an IP. */
function looksLikeTarget(value) {
  if (NON_TARGETS.has(value.trim())) return false;
  if (value.includes('://')) return true;
  if (value.includes('@') && value.includes('.')) return true;
  if (/^\/[^/]/.test(value)) return true;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return true;
  return false;
}

function classify(varName, value, isShell) {
  // An empty default is "absent" — the honest encoding of "not configured", not a guess.
  if (value.trim() === '') return null;
  // Numeric / boolean defaults are tunables: bounded, and loud when wrong.
  if (/^(true|false|\d+(\.\d+)?)$/i.test(value.trim())) return null;
  if (NON_TARGETS.has(value.trim())) return null;
  // `?? `${webUrl}/api`` DERIVES from a value that is already required, so the target is still
  // chosen by configuration — the opposite of a guess. Only inert literals can be guesses.
  if (value.includes('${')) return null;
  // Prose. A default containing spaces is display copy ("this computer"), not an address.
  if (/\s/.test(value) && !looksLikeTarget(value)) return null;
  // Shell judges on the VALUE only. `${FOO:-bar}` is pervasive and usually a label or a flag;
  // scoring it on the variable's name too (PATH, DIR, USER, KEY…) buries the real findings.
  if (isShell) return looksLikeTarget(value) ? 'error' : null;
  if (looksLikeTarget(value) || TARGET_NAME.test(varName)) return 'error';
  return 'warn';
}

function scanText(file, text) {
  const out = [];
  const lines = text.split('\n');
  const isShell = /\.(sh|bash|ya?ml)$/.test(file);

  lines.forEach((raw, i) => {
    const line = raw.trim();
    // Skip comments — a documented example is not a live default.
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('#')) return;

    // Escape hatch: `fallback-ok` — the SAME token the machine-global write-time guard honours, so
    // one annotation satisfies both and nobody has to learn two dialects. Accepted on this line or
    // the one above, which is where the reason usually goes when it doesn't fit inline. Write the
    // reason; a bare suppression only hides the next real finding.
    const context = `${lines[i - 1] ?? ''}\n${raw}`;
    if (/fallback-ok|default-ok/i.test(context)) return;

    const [re, pick] = isShell
      ? [SHELL_DEFAULT, (m) => [m[1], m[2]]]
      : [ENV_DEFAULT, (m) => [m[1] ?? m[2], m[4]]];

    re.lastIndex = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const [varName, value] = pick(m);
      const level = classify(varName, value, isShell);
      if (!level) continue;
      out.push({
        file,
        line: i + 1,
        text: line.slice(0, 140),
        varName,
        value,
        level,
        why:
          level === 'error'
            ? `"${value}" names a target. A missing ${varName} must fail loudly, not silently point somewhere.`
            : `${varName} is defaulted to "${value}". Confirm this is a tunable, not a destination.`,
      });
    }
  });
  return out;
}

// `git ls-files` is relative to the CWD, so anchor at the repo root — run from a subdirectory it
// would otherwise scan a handful of files and pronounce the project clean.
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
process.chdir(root);
const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n')
  .filter((f) => SCANNABLE.test(f))
  .filter((f) => !f.startsWith('.claude/skills/'));

const findings = [];
for (const file of tracked) {
  findings.push(...scanText(file, readFileSync(file, 'utf8')));
}

const errors = findings.filter((f) => f.level === 'error');
const warns = findings.filter((f) => f.level === 'warn');

console.log('━'.repeat(39));
console.log(`fallback-scan: scanned ${tracked.length} tracked files`);
for (const [group, heading] of [
  [errors, '\n❌ GUESSED TARGETS (must be required):'],
  [warns, '\n⚠️  DEFAULTED VALUES (review):'],
]) {
  if (group.length === 0) continue;
  console.log(heading);
  for (const f of group) {
    console.log(`  ${f.file}:${f.line}  ${f.varName} → "${f.value}"`);
    console.log(`    ${f.text}`);
    console.log(`    ${f.why}`);
  }
}
if (findings.length === 0) console.log('✅ no guessed configuration defaults found');
console.log('━'.repeat(39));

process.exit(errors.length > 0 ? 1 : 0);
