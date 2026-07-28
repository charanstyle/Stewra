#!/usr/bin/env node
/**
 * fallback-guard — refuse configuration defaults that GUESS A TARGET.
 *
 * The rule this enforces: a setting that names *where* something goes — a host, a URL, a container,
 * a mailbox, a database — must be required, and its absence must fail loudly at boot. Writing
 * `process.env.SSH_HOST || 'home'` does not make the code more robust; it converts a missing setting
 * into a run that quietly targets the wrong machine, and every error after that describes the wrong
 * system. A thrown error at startup is strictly more useful than a successful run against a server
 * nobody chose.
 *
 * What is NOT a violation, deliberately:
 *   - `?? ''` / `|| ''`  — an empty string means "absent", which is the honest answer, not a guess.
 *   - `?? OTHER_VAR`     — derivation from another value (e.g. wsUrl falling back to apiUrl).
 *   - numbers, booleans  — timeouts, page sizes, retry counts. A wrong tunable is bounded and loud;
 *                          a wrong target is silent. Only string literals are flagged.
 *   - feature switches defaulting OFF — absence disabling a feature is the safe direction.
 *
 * Two modes:
 *   stdin JSON  → PreToolUse hook. Blocks (exit 2) on a target-guess in an edit; warns otherwise.
 *   --scan      → walks every git-tracked file and reports. Exit 1 if any error-level finding.
 */
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';

interface HookInput {
    tool_name?: string;
    tool_input?: {
        file_path?: string;
        content?: string;
        new_string?: string;
        edits?: Array<{ new_string?: string }>;
    };
}

interface Finding {
    file: string;
    line: number;
    text: string;
    varName: string;
    value: string;
    level: 'error' | 'warn';
    why: string;
}

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
 * where logs go — it is the idiomatic way to spell "discard unless someone asked for a file".
 */
const NON_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/tmp', '.', './', '/']);

/** Values that look like a destination: a URL, a hostname, an absolute path, an email. */
function looksLikeTarget(value: string): boolean {
    if (NON_TARGETS.has(value.trim())) return false;
    if (value.includes('://')) return true;
    if (value.includes('@') && value.includes('.')) return true;
    if (/^\/[^/]/.test(value)) return true;
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value)) return true;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return true;
    return false;
}

function classify(varName: string, value: string, isShell: boolean): Finding['level'] | null {
    // An empty default is "absent", not a guess — the honest encoding of "not configured".
    if (value.trim() === '') return null;
    // Numeric / boolean defaults are tunables, bounded and loud when wrong.
    if (/^(true|false|\d+(\.\d+)?)$/i.test(value.trim())) return null;
    if (NON_TARGETS.has(value.trim())) return null;
    // `?? \`${webUrl}/api\`` DERIVES from a value that is already required, so the target is still
    // chosen by configuration — the opposite of a guess. Only inert literals can be guesses.
    if (value.includes('${')) return null;
    // Prose. A default with spaces is display copy ("this computer"), not an address.
    if (/\s/.test(value) && !looksLikeTarget(value)) return null;
    // Shell judges on the VALUE only. `${FOO:-bar}` is pervasive and usually a label or a flag;
    // scoring it on the variable's name too (PATH, DIR, USER, KEY…) buries the real findings.
    if (isShell) return looksLikeTarget(value) ? 'error' : null;
    if (looksLikeTarget(value) || TARGET_NAME.test(varName)) return 'error';
    return 'warn';
}

function scanText(file: string, text: string): Finding[] {
    const out: Finding[] = [];
    const lines = text.split('\n');
    const isShell = /\.(sh|bash|ya?ml)$/.test(file);

    lines.forEach((raw, i) => {
        const line = raw.trim();
        // Skip comments — a documented example is not a live default.
        if (line.startsWith('//') || line.startsWith('*') || line.startsWith('#')) return;

        // An escape hatch that costs something: `fallback-guard-ok: <reason>` on this line or the
        // one above it. The reason is mandatory, so accepting a default leaves a record of who
        // decided it was safe and why — a bare suppression would just hide the next real one.
        const context = `${lines[i - 1] ?? ''}\n${raw}`;
        if (/fallback-guard-ok:\s*\S+/.test(context)) return;

        const patterns: Array<[RegExp, (m: RegExpExecArray) => [string, string]]> = isShell
            ? [[SHELL_DEFAULT, (m) => [m[1], m[2]]]]
            : [[ENV_DEFAULT, (m) => [m[1] ?? m[2], m[4]]]];

        for (const [re, pick] of patterns) {
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
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
        }
    });
    return out;
}

function report(findings: Finding[]): void {
    const errors = findings.filter((f) => f.level === 'error');
    const warns = findings.filter((f) => f.level === 'warn');
    for (const group of [errors, warns]) {
        if (group.length === 0) continue;
        console.error(group === errors ? '\n❌ GUESSED TARGETS (must be required):' : '\n⚠️  DEFAULTED VALUES (review):');
        for (const f of group) {
            console.error(`  ${f.file}:${f.line}  ${f.varName} → "${f.value}"`);
            console.error(`    ${f.text}`);
            console.error(`    ${f.why}`);
        }
    }
}

function scanRepo(): never {
    // Anchored at the repo root: `git ls-files` is relative to the CWD, and this hook is invoked
    // from .claude/hooks, which would silently scan 25 files and call the project clean.
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    process.chdir(root);
    const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\n')
        .filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|sh|bash|ya?ml)$/.test(f))
        // The hooks' own vendored deps and the skill docs are not application config.
        .filter((f) => !f.startsWith('.claude/skills/') && !f.includes('/node_' + 'modules/'));

    const findings: Finding[] = [];
    for (const file of tracked) {
        let text = '';
        try {
            text = readFileSync(file, 'utf8');
        } catch {
            continue;
        }
        findings.push(...scanText(file, text));
    }

    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(`fallback-guard: scanned ${tracked.length} tracked files`);
    if (findings.length === 0) {
        console.error('✅ no guessed configuration defaults found');
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        process.exit(0);
    }
    report(findings);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    process.exit(findings.some((f) => f.level === 'error') ? 1 : 0);
}

function main(): void {
    if (process.argv.includes('--scan')) scanRepo();

    let input: HookInput = {};
    try {
        input = JSON.parse(readFileSync(0, 'utf8')) as HookInput;
    } catch {
        process.exit(0); // Not hook input and not --scan: nothing to do.
    }

    const ti = input.tool_input ?? {};
    const file = ti.file_path ?? '<edit>';
    if (!/\.(ts|tsx|js|jsx|mjs|cjs|sh|bash|ya?ml)$/.test(file)) process.exit(0);

    const chunks = [ti.content, ti.new_string, ...(ti.edits ?? []).map((e) => e.new_string)].filter(
        (c): c is string => typeof c === 'string',
    );
    const findings = chunks.flatMap((c) => scanText(file, c));
    if (findings.length === 0) process.exit(0);

    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('🛑 fallback-guard: configuration default that guesses a target');
    report(findings);
    console.error('\n💡 Instead: require it, and throw when it is absent.');
    console.error("   const host = required(env.SSH_HOST, 'SSH_HOST');");
    console.error('   Optional features: gate on ONE switch, then require the rest.');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    process.exit(findings.some((f) => f.level === 'error') ? 2 : 0);
}

try {
    main();
} catch (err) {
    console.error('Error in fallback-guard hook:', err);
    process.exit(0); // Fail open: never block work because the guard itself broke.
}
