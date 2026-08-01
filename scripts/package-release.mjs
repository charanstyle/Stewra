// Stage the built runner + bridge artifacts into dist-release/ under the exact asset names the public
// download page (website/src/app/runner/RunnerDownloadPage.tsx) links to, with SHA-256 checksums.
//
// This does NOT publish. Publishing uploads dist-release/* to a GitHub Release on charanstyle/Stewra
// (the URLs use `releases/latest/download/<name>`), which is a live external action — run it yourself:
//
//   gh release create v2026.xx.xx dist-release/* --title "Bridge 1.1.0 / Runner 0.2.0" --notes "..."
//
// ⚠️ `releases/latest` is BOTH the download page's link target AND the installed bridges' auto-update
// feed (latest-mac.yml / latest-linux.yml). So: every normal release must be a COMBINED release
// carrying the bridge artifacts plus both ymls (this script hard-fails a partial platform below); a
// deliberately partial release — runner-only, a test build — must be created with `--prerelease`,
// which keeps it off `releases/latest` so installed bridges never see it.
//
// Build the inputs first (on each OS for its targets):
//   ( cd runner && npm run package )        -> runner/build/stewra-runner-<os>-<arch>
//   ( cd bridge && npm run package:linux )  -> bridge/release/*.AppImage, *.deb
//   ...and npm run package:mac on the Mac. (No Windows targets yet — no machine to build/test on.)
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
import { basename, dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-release');

// runner/scripts/package-binary.mjs names its output for the platform+arch it was built on, which is
// already the asset name — so source filename == asset name and there is no mapping to get wrong.
// `os` drives the sanity check below.
const runner = (os, name) => ({ name, os, file: join(root, 'runner', 'build', name) });

const bridgeRelease = join(root, 'bridge', 'release');

// Map: canonical release-asset name -> how to find the freshly built file.
// `dir` is scanned and the first file matching `match` is taken (handles version-stamped filenames).
// `keepName: true` stages under the source's own (version-stamped) basename — REQUIRED for every
// asset that latest-mac.yml / latest-linux.yml references: electron-updater downloads exactly the
// name in the yml, so renaming those breaks auto-update with a 404 on every installed bridge.
// `group` ties a platform's bridge artifacts together for the all-or-nothing check below.
const artifacts = [
  runner('linux', 'stewra-runner-linux-x64'),
  runner('macos', 'stewra-runner-macos-arm64'),
  runner('macos', 'stewra-runner-macos-x64'),
  // Stable names the download page links (releases/latest/download/<name> never changes) …
  { name: 'Stewra-Bridge-x86_64.AppImage', dir: bridgeRelease, match: /x86_64\.AppImage$/, group: 'bridge-linux' },
  { name: 'stewra-bridge-amd64.deb', dir: bridgeRelease, match: /amd64\.deb$/, group: 'bridge-linux' },
  // Arch-qualified stable names — the download page links each dmg by exactly these. The patterns
  // are anchored per arch ("-arm64" / "-x64") so neither can swallow the other's file.
  { name: 'Stewra-Bridge-arm64.dmg', dir: bridgeRelease, match: /-arm64\.dmg$/, group: 'bridge-mac' },
  { name: 'Stewra-Bridge-x64.dmg', dir: bridgeRelease, match: /-x64\.dmg$/, group: 'bridge-mac' },
  // … and the auto-update feed: the versioned AppImage (yes, the same file uploaded twice — the yml
  // needs the versioned name, the download page the stable one), the macOS zip, and the ymls.
  { keepName: true, dir: bridgeRelease, match: /^Stewra-Bridge-.*x86_64\.AppImage$/, group: 'bridge-linux' },
  { name: 'latest-linux.yml', file: join(bridgeRelease, 'latest-linux.yml'), group: 'bridge-linux' },
  { keepName: true, dir: bridgeRelease, match: /-arm64\.zip$/, group: 'bridge-mac' },
  { keepName: true, dir: bridgeRelease, match: /-x64\.zip$/, group: 'bridge-mac' },
  // The MERGED feed (bridge/scripts/merge-latest-mac.mjs) listing both arches' zips. The per-arch
  // latest-mac-<arch>.yml collections are inputs to that merge, never release assets themselves.
  { name: 'latest-mac.yml', file: join(bridgeRelease, 'latest-mac.yml'), group: 'bridge-mac' },
  // Blockmaps make updates differential; without them electron-updater just downloads in full. The
  // only optional entry — everything else that exists partially is a broken release (see below).
  { keepName: true, multi: true, optional: true, dir: bridgeRelease, match: /\.blockmap$/ },
  // License terms ship with every release: the download page footer links
  // `releases/latest/download/EULA.md`, so the asset must exist under exactly that name.
  { name: 'EULA.md', file: join(root, 'EULA.md') },
  { name: 'LICENSE', file: join(root, 'LICENSE') },
];

// Executable-format magic numbers, read as a big-endian u32 so the byte order in the literal matches
// the byte order on disk. macOS covers thin Mach-O (both endiannesses) and fat/universal binaries.
const MAGIC = {
  linux: { label: 'ELF', ok: (m) => (m & 0xffffff00) >>> 0 === 0x7f454c00 },
  macos: { label: 'Mach-O', ok: (m) => [0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(m) },
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

function resolveSources(a) {
  if (a.file) {
    return existsSync(a.file) ? [a.file] : [];
  }
  if (!existsSync(a.dir)) {
    return [];
  }
  // Skip AppleDouble sidecars. On a filesystem without native xattrs (this repo often lives on exFAT)
  // macOS leaves a `._Stewra Bridge-1.0.0-arm64.dmg` beside the real one — it matches the same pattern,
  // sorts FIRST, and is a few KB of metadata. Staging that as the release artifact would be silent.
  const hits = readdirSync(a.dir)
    .filter((f) => !f.startsWith('._'))
    .filter((f) => a.match.test(f));
  return (a.multi ? hits : hits.slice(0, 1)).map((f) => join(a.dir, f));
}

/** What to call an artifact in "missing" output — keepName entries have no fixed name to print. */
const describe = (a) => a.name ?? `${a.dir ? basename(a.dir) + '/' : ''}${a.match}`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const staged = [];
const missing = [];
/** group -> { staged: [names], missing: [labels] } for the all-or-nothing check below. */
const groups = new Map();
const groupOf = (g) => {
  if (!groups.has(g)) groups.set(g, { staged: [], missing: [] });
  return groups.get(g);
};

for (const a of artifacts) {
  const sources = resolveSources(a);
  if (sources.length === 0) {
    if (!a.optional) {
      missing.push(describe(a));
      if (a.group) groupOf(a.group).missing.push(describe(a));
    }
    continue;
  }
  for (const src of sources) {
    if (a.os !== undefined) {
      assertFormat(a, src);
    }
    const name = a.keepName ? basename(src) : a.name;
    const dest = join(out, name);
    copyFileSync(src, dest);
    const sha = createHash('sha256').update(readFileSync(dest)).digest('hex');
    staged.push({ name, sha });
    if (a.group) groupOf(a.group).staged.push(name);
    console.log(`staged  ${name}`);
  }
}

// A platform's bridge artifacts are all-or-nothing. A dmg without its zip + latest-mac.yml (or an
// AppImage without its versioned twin + latest-linux.yml) publishes fine, downloads fine — and every
// installed bridge on that platform silently stops receiving updates, or 404s trying. A missing
// WHOLE platform is legitimate (each OS builds its own artifacts on its own machine); a PARTIAL
// platform is always a broken build, so it refuses here, at staging, not on users' machines.
for (const [group, g] of groups) {
  if (g.staged.length > 0 && g.missing.length > 0) {
    console.error(
      `\n!! ${group}: staged ${g.staged.join(', ')} but could not find: ${g.missing.join(', ')}\n` +
        '!! A bridge artifact without its auto-update metadata breaks updates for every installed\n' +
        '!! bridge on that platform. Rebuild the platform (the packaging scripts emit all of these\n' +
        '!! together) instead of publishing a partial set.',
    );
    process.exit(1);
  }
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
console.log('  (partial/test releases: add --prerelease, or installed bridges will treat it as an update)');
