// Runs the whole website E2E suite in sequence: full feature matrix, then audio + video calls.
// Each sub-suite is a separate node process so one crash can't take down the rest.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  ['Feature matrix', 'full.mjs', []],
  ['Audio calls', 'calls.audio.mjs', ['3']],
  ['Video calls', 'calls.video.mjs', ['3']],
];

function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, script), ...args], { stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

(async () => {
  const results = [];
  for (const [name, script, args] of SUITES) {
    console.log(`\n\n######## ${name} (${script}) ########\n`);
    const code = await run(script, args);
    results.push([name, code]);
  }
  console.log('\n\n======== SUITE SUMMARY ========');
  for (const [name, code] of results) {
    console.log(`${code === 0 ? '✅' : '❌'} ${name} (exit ${code})`);
  }
  process.exit(results.every(([, c]) => c === 0) ? 0 : 1);
})();
