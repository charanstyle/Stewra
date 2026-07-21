// Build a single self-contained `stewra-runner` executable from src/cli.ts.
//
// Pipeline: esbuild bundles the ESM runner (+ all pure-JS deps) into one CJS file, then Node's
// Single Executable Application (SEA) support injects that bundle into a copy of the running `node`
// binary via postject. The result needs no Node install and no repo checkout — download and run.
//
// Cross-platform: run this ON the target OS to get that OS's binary (SEA can't cross-compile the host
// node). Linux/Windows just inject the blob; macOS additionally strips and re-applies an ad-hoc
// signature. Code-signing/notarization for distribution is left to the release step (needs real certs).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const esbuildBin = require.resolve('esbuild/bin/esbuild');
const { inject } = require('postject');

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'build');
const platform = process.platform;
const exeName = platform === 'win32' ? 'stewra-runner.exe' : 'stewra-runner';
const exePath = join(out, exeName);
const bundle = join(out, 'runner.cjs');
const blob = join(out, 'sea-prep.blob');
const seaConfig = join(out, 'sea-config.json');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. Bundle. Optional native ws accelerators are left external — ws falls back to pure JS when they
//    are absent, which is exactly what a portable binary wants.
console.log('esbuild: bundling src/cli.ts -> build/runner.cjs');
execFileSync(
  esbuildBin,
  [
    join(root, 'src', 'cli.ts'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node22',
    // ws's optional native accelerators can't be require()d from disk inside a single-executable app.
    // Aliasing them to a throwing stub (instead of leaving them external) means the bundle makes NO
    // runtime require() of a non-builtin — which also removes Node's SEA "require() supports built-in
    // modules only" notice — while ws still catches the throw and uses its pure-JS fallback.
    `--alias:bufferutil=${join(here, 'native-addon-stub.cjs')}`,
    `--alias:utf-8-validate=${join(here, 'native-addon-stub.cjs')}`,
    `--outfile=${bundle}`,
  ],
  { stdio: 'inherit' },
);

// 2. SEA blob.
writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }, null, 2),
);
console.log('sea: generating blob');
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

// 3. Copy the host node binary and inject the blob into it.
copyFileSync(process.execPath, exePath);
if (platform === 'darwin') {
  // A signed Mach-O must have its signature removed before postject rewrites it, then re-signed.
  try {
    execFileSync('codesign', ['--remove-signature', exePath], { stdio: 'inherit' });
  } catch {
    /* unsigned already */
  }
}

console.log('postject: injecting blob into binary');
await inject(exePath, 'NODE_SEA_BLOB', readFileSync(blob), {
  sentinelFuse: FUSE,
  ...(platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
});

if (platform === 'darwin') {
  execFileSync('codesign', ['--sign', '-', exePath], { stdio: 'inherit' });
}
if (platform !== 'win32') {
  chmodSync(exePath, 0o755);
}

console.log(`\nBuilt: ${exePath}`);
