// Stage the built runner + bridge artifacts into dist-release/ under the exact asset names the public
// download page (website/src/app/runner/RunnerDownloadPage.tsx) links to, with SHA-256 checksums.
//
// This does NOT publish. Publishing uploads dist-release/* to a GitHub Release on charanstyle/Stewra
// (the URLs use `releases/latest/download/<name>`), which is a live external action — run it yourself:
//
//   gh release create runner-v0.1.0 dist-release/* --title "Runner 0.1.0 / Bridge 1.0.0" --notes "..."
//
// Build the inputs first (on each OS for its targets):
//   ( cd runner && npm run package )        -> runner/build/stewra-runner-<os>-<arch>
//   ( cd bridge && npm run package:linux )  -> bridge/release/*.AppImage, *.deb
//   ...and npm run package:mac / :win on those platforms.
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-release');

// runner/scripts/package-binary.mjs names its output for the platform+arch it was built on, which is
// already the asset name — so source filename == asset name and there is no mapping to get wrong.
// `os` drives the sanity check below.
const runner = (os, name) => ({ name, os, file: join(root, 'runner', 'build', name) });

// Map: canonical release-asset name -> how to find the freshly built file.
// `dir` is scanned and the first file matching `match` is taken (handles version-stamped filenames).
const artifacts = [
  runner('linux', 'stewra-runner-linux-x64'),
  runner('macos', 'stewra-runner-macos-arm64'),
  runner('macos', 'stewra-runner-macos-x64'),
  runner('win', 'stewra-runner-win-x64.exe'),
  { name: 'Stewra-Bridge-x86_64.AppImage', dir: join(root, 'bridge', 'release'), match: /x86_64\.AppImage$/ },
  { name: 'stewra-bridge-amd64.deb', dir: join(root, 'bridge', 'release'), match: /amd64\.deb$/ },
  // Arch-qualified: only an Apple Silicon dmg is published, and the download page links it by this
  // exact name. `Stewra-Bridge.dmg` here would stage under a name nothing links to — a silent 404.
  { name: 'Stewra-Bridge-arm64.dmg', dir: join(root, 'bridge', 'release'), match: /arm64\.dmg$/ },
  { name: 'Stewra-Bridge-Setup.exe', dir: join(root, 'bridge', 'release'), match: /Setup.*\.exe$|\.exe$/ },
];

// Executable-format magic numbers, read as a big-endian u32 so the byte order in the literal matches
// the byte order on disk. macOS covers thin Mach-O (both endiannesses) and fat/universal binaries.
const MAGIC = {
  linux: { label: 'ELF', ok: (m) => (m & 0xffffff00) >>> 0 === 0x7f454c00 },
  macos: { label: 'Mach-O', ok: (m) => [0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(m) },
  win: { label: 'PE', ok: (m) => m >>> 16 === 0x4d5a },
};

// The bug this replaced published a darwin binary under the linux-x64 name. That is invisible until a
// user downloads it, so verify the bytes agree with the name rather than trusting the filename.
function assertFormat(a, src) {
  // Read just the header — these binaries are ~110 MB and the whole file gets read again for the hash.
  const head = Buffer.alloc(4);
  const fd = openSync(src, 'r');
  try {
    readSync(fd, head, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  const magic = head.readUInt32BE(0);
  if (!MAGIC[a.os].ok(magic)) {
    throw new Error(
      `${a.name}: expected a ${MAGIC[a.os].label} executable, but ${src} starts with ` +
        `0x${magic.toString(16).padStart(8, '0')}. Refusing to stage a mislabeled binary.`,
    );
  }
}

function resolveSource(a) {
  if (a.file) {
    return existsSync(a.file) ? a.file : null;
  }
  if (!existsSync(a.dir)) {
    return null;
  }
  // Skip AppleDouble sidecars. On a filesystem without native xattrs (this repo often lives on exFAT)
  // macOS leaves a `._Stewra Bridge-1.0.0-arm64.dmg` beside the real one — it matches the same pattern,
  // sorts FIRST, and is a few KB of metadata. Staging that as the release artifact would be silent.
  const hit = readdirSync(a.dir)
    .filter((f) => !f.startsWith('._'))
    .find((f) => a.match.test(f));
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
  if (a.os !== undefined) {
    assertFormat(a, src);
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
  // SHA256SUMS.txt lists ONLY what was staged here, but it is a whole-release file with a fixed name.
  // Uploading it with --clobber therefore replaces the published one and silently deletes the checksums
  // of every asset built on another machine. The file looks complete either way; the only symptom is a
  // user checking a Linux download against a list that no longer mentions it.
  console.log(
    '\n!! SHA256SUMS.txt covers ONLY the artifacts staged above.\n' +
      '!! Do NOT `gh release upload --clobber` it as-is — that drops the checksums of the assets\n' +
      '!! built elsewhere. Merge it with the published one first:\n' +
      '!!   gh release download <tag> --pattern SHA256SUMS.txt --dir /tmp\n' +
      '!!   then keep /tmp lines for the skipped assets and take these for the staged ones.',
  );
}
console.log('\nPublish (runs against GitHub — do this yourself):');
console.log('  gh release create <tag> dist-release/* --title "..." --notes "..."');
