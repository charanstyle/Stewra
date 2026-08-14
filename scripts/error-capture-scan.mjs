#!/usr/bin/env node
/**
 * error-capture-scan — audit the backend for errors that are caught, logged, and then not reported.
 *
 * The rule: an error the code decides to survive still has to reach a human. `catch (e) { logger.warn(...) }`
 * is not error handling, it is error *absorption* — the request succeeds, the log line scrolls past on a
 * box nobody is tailing, and the failure runs for months. The behaviour is often right (a transient email
 * hiccup must not fail registration); what is wrong is that nothing raises a hand. Sentry is what raises
 * the hand, so a swallowed error without a capture is the finding.
 *
 * Two rules, because there are two spellings of the same mistake:
 *
 *   1. `logger.error(...)` ANYWHERE with no capture nearby. `error` is the code's own word for "this is
 *      wrong". If it is worth that word it is worth an alert. This deliberately reaches beyond catch
 *      blocks: services/runnerService.ts logs "its container must be removed by hand" from a plain `else`
 *      branch — no exception involved, and the single most alert-worthy line in the file.
 *   2. `logger.warn(...)` INSIDE a catch block with no capture in that block. A caught exception
 *      downgraded to a warning is the exact shape of a hidden error. A warn outside a catch is a
 *      judgement about normal operation and is left alone.
 *
 * Scope is backend/src: that is where `@sentry/node` is initialised (backend/src/instrument.ts) and where
 * a swallowed error is invisible to the user who caused it. Client code reports differently and is not
 * covered here rather than being covered badly.
 *
 * Escape hatch: `capture-ok: <reason>` on the offending line or in the comment block directly above it —
 * same spirit as fallback-scan's `fallback-ok`. Two cases earn it, and they are the only two: the error
 * is RE-THROWN and captured at the edge by `BaseController.handleError`, or it is an expected client
 * error (a rejected PIN, a bad password) where paging would bury the faults that need someone. Write the
 * reason; a bare suppression only hides the next real finding.
 *
 *   node scripts/error-capture-scan.mjs      # exit 1 if any finding
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Largest enclosing block, in lines, that still counts as "this log line is reported". A capture at the
 * top of a 25-line method covers a log at its bottom — baseController.handleError does exactly that, and
 * a fixed ±12-line window called it a violation. A capture 400 lines away in the same class does not
 * cover anything, so the span is bounded rather than walked to the top of the file.
 */
const BLOCK_SPAN = 60;

const LOGGER_ERROR = /\blogger\s*\.\s*error\s*\(/;
const LOGGER_WARN = /\blogger\s*\.\s*warn\s*\(/;
const CAPTURE = /\b(?:Sentry\s*\.\s*)?capture(?:Exception|Message)\s*\(/;
const CATCH_OPEN = /\bcatch\s*(?:\([^)]*\)\s*)?\{/;

/**
 * Strip line comments and string literals before counting braces. A brace inside `'}'` or a `// }` would
 * otherwise close a block early and make the scanner quietly under-report — the failure mode a linter
 * must not have.
 */
function decomment(line) {
  return line
    .replace(/\\./g, '')
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''")
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*?\*\//g, '');
}

/**
 * Line indices (0-based, inclusive) of every brace block in the file, innermost-first at any given line.
 * `onlyCatch` restricts the openers to `catch (…) {`.
 */
function braceBlocks(lines, onlyCatch) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const bare = decomment(lines[i]);
    const m = onlyCatch ? CATCH_OPEN.exec(bare) : /\{/.exec(bare);
    if (m === null) continue;
    // Count from the catch's OWN opening brace, not the start of the line: `} catch (e) {` carries the
    // `}` that closes the preceding `try`, and counting it drove depth negative on character one — the
    // block "ended" where it began and every warn inside it went unseen. Found because the warn rule
    // returned zero findings on a file known to violate it.
    let depth = 0;
    let started = false;
    let end = i;
    for (let j = i; j < lines.length; j++) {
      const body = j === i ? bare.slice(m.index + m[0].length - 1) : decomment(lines[j]);
      for (const ch of body) {
        if (ch === '{') {
          depth += 1;
          started = true;
        } else if (ch === '}') {
          depth -= 1;
        }
      }
      if (started && depth <= 0) {
        end = j;
        break;
      }
      end = j;
    }
    blocks.push({ start: i, end });
  }
  return blocks;
}

/**
 * `capture-ok` on the offending line, or anywhere in the contiguous comment block immediately above it.
 * Not just the single preceding line: a reason worth writing rarely fits on one, and a suppression that
 * silently stops working when the author adds a second line of explanation is a trap.
 */
function suppressed(lines, i) {
  if (/capture-ok/i.test(lines[i])) return true;
  for (let j = i - 1; j >= 0; j--) {
    const t = lines[j].trim();
    if (!(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))) return false;
    if (/capture-ok/i.test(t)) return true;
  }
  return false;
}

function scanFile(file, text) {
  const lines = text.split('\n');
  const blocks = braceBlocks(lines, true);
  const allBlocks = braceBlocks(lines, false);
  const out = [];

  const enclosingBlock = (i) => blocks.find((b) => i >= b.start && i <= b.end);
  const blockHasCapture = (b) => lines.slice(b.start, b.end + 1).some((l) => CAPTURE.test(l));
  /** Any enclosing block short enough to be one unit of reasoning contains a capture. */
  const scopeHasCapture = (i) =>
    allBlocks
      .filter((b) => i >= b.start && i <= b.end && b.end - b.start <= BLOCK_SPAN)
      .some(blockHasCapture);

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith('//') || line.startsWith('*')) return;
    if (suppressed(lines, i)) return;

    const block = enclosingBlock(i);

    if (LOGGER_ERROR.test(raw)) {
      const reported = block ? blockHasCapture(block) : scopeHasCapture(i);
      if (!reported) {
        out.push({
          file,
          line: i + 1,
          text: line.slice(0, 140),
          rule: 'logger.error without capture',
          why: 'The code calls this an error. Nothing pages anyone. Add Sentry.captureException/captureMessage, or downgrade the level if it is not one.',
        });
      }
      return;
    }

    if (LOGGER_WARN.test(raw) && block && !blockHasCapture(block)) {
      out.push({
        file,
        line: i + 1,
        text: line.slice(0, 140),
        rule: 'caught error warned, not reported',
        why: 'A caught exception downgraded to a warning is a hidden failure. Capture it, then continue if continuing is right.',
      });
    }
  });

  return out;
}

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
process.chdir(root);
const tracked = execFileSync('git', ['ls-files', 'backend/src'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n')
  .filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f));

const findings = [];
for (const file of tracked) {
  findings.push(...scanFile(file, readFileSync(file, 'utf8')));
}

console.log('━'.repeat(39));
console.log(`error-capture-scan: scanned ${tracked.length} backend source files`);
if (findings.length > 0) {
  console.log('\n❌ SWALLOWED ERRORS (must reach Sentry):');
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}  [${f.rule}]`);
    console.log(`    ${f.text}`);
    console.log(`    ${f.why}`);
  }
} else {
  console.log('✅ every logged error is also reported');
}
console.log('━'.repeat(39));

process.exit(findings.length > 0 ? 1 : 0);
