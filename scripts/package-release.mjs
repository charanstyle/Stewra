// Stage the built runner + bridge artifacts into dist-release/ under the exact asset names the public
// download page (website/src/app/runner/RunnerDownloadPage.tsx) links to, with SHA-256 checksums.
//
// This does NOT publish. Publishing uploads dist-release/* to a GitHub Release on charanstyle/Stewra
// (the URLs use `releases/latest/download/<name>`), which is a live external action — run it yourself:
//
//   gh release create runner-v0.1.0 dist-release/* --title "Runner 0.1.0 / Bridge 1.0.0" --notes "..."
//
// Build the inputs first (on each OS for its targets):
//   ( cd runner && npm run package )        -> runner/build/stewra-runner
//   ( cd bridge && npm run package:linux )  -> bridge/release/*.AppImage, *.deb
//   ...and npm run package:mac / :win on those platforms.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-release');

// Map: canonical release-asset name -> how to find the freshly built file.
// `dir` is scanned and the first file matching `match` is taken (handles version-stamped filenames).
const artifacts = [
  { name: 'stewra-runner-linux-x64', file: join(root, 'runner', 'build', 'stewra-runner') },
  { name: 'stewra-runner-macos-arm64', file: join(root, 'runner', 'build', 'stewra-runner-macos-arm64') },
  { name: 'stewra-runner-macos-x64', file: join(root, 'runner', 'build', 'stewra-runner-macos-x64') },
  { name: 'stewra-runner-win-x64.exe', file: join(root, 'runner', 'build', 'stewra-runner.exe') },
  { name: 'Stewra-Bridge-x86_64.AppImage', dir: join(root, 'bridge', 'release'), match: /x86_64\.AppImage$/ },
  { name: 'stewra-bridge-amd64.deb', dir: join(root, 'bridge', 'release'), match: /amd64\.deb$/ },
  { name: 'Stewra-Bridge.dmg', dir: join(root, 'bridge', 'release'), match: /\.dmg$/ },
  { name: 'Stewra-Bridge-Setup.exe', dir: join(root, 'bridge', 'release'), match: /Setup.*\.exe$|\.exe$/ },
];

function resolveSource(a) {
  if (a.file) {
    return existsSync(a.file) ? a.file : null;
  }
  if (!existsSync(a.dir)) {
    return null;
  }
  const hit = readdirSync(a.dir).find((f) => a.match.test(f));
  return hit ? join(a.dir, hit) : null;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const staged = [];
const missing = [];
for (const a of artifacts) {
  const src = resolveSource(a);
  if (src === null) {
    missing.push(a.name);
    continue;
  }
  const dest = join(out, a.name);
  copyFileSync(src, dest);
  const sha = createHash('sha256').update(readFileSync(dest)).digest('hex');
  staged.push({ name: a.name, sha });
  console.log(`staged  ${a.name}`);
}

if (staged.length > 0) {
  writeFileSync(join(out, 'SHA256SUMS.txt'), staged.map((s) => `${s.sha}  ${s.name}`).join('\n') + '\n');
}

console.log(`\n${staged.length} artifact(s) in dist-release/ (+ SHA256SUMS.txt).`);
if (missing.length > 0) {
  // Loud about what is NOT covered — the mac/win builds must run on those OSes.
  console.log(`Not built on this OS (skipped): ${missing.join(', ')}`);
}
console.log('\nPublish (runs against GitHub — do this yourself):');
console.log('  gh release create <tag> dist-release/* --title "..." --notes "..."');
