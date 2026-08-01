// Combine the per-arch update feeds into the ONE latest-mac.yml a release ships.
//
// Each `npm run package:mac` run (arm64, then `-- --x64`) collects its feed as
// release/latest-mac-<arch>.yml — electron-builder names the file latest-mac.yml internally, so
// without the suffix the second arch's run would replace the first's and the published feed would
// only ever mention one arch. electron-updater picks its own arch's entry out of `files`, so the
// merged feed must carry BOTH zips (and their dmgs) side by side.
//
// No YAML library: the feed is electron-builder's own flat emission (version / files list / legacy
// path+sha512+releaseDate tail), and a line-level merge that asserts what it relies on is sturdier
// than a parse–mutate–serialize round-trip that could reorder or requote what installed apps parse.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const releaseDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'release');

const inputs = readdirSync(releaseDir)
  .filter((f) => /^latest-mac-[a-z0-9_]+\.yml$/.test(f))
  .sort() // deterministic order: arm64 before x64, so reruns emit byte-identical output
  .map((f) => ({ name: f, text: readFileSync(join(releaseDir, f), 'utf8') }));

if (inputs.length === 0) {
  console.error('merge-latest-mac: no release/latest-mac-<arch>.yml found — run npm run package:mac first');
  process.exit(1);
}

/** Split one feed into { version, entries: [entry-lines[]], tail: [lines] }. */
function parse({ name, text }) {
  const lines = text.split('\n');
  let version = null;
  const entries = [];
  const tail = [];
  let inFiles = false;
  for (const line of lines) {
    if (line.startsWith('version:')) {
      version = line.slice('version:'.length).trim();
    } else if (line === 'files:') {
      inFiles = true;
    } else if (inFiles && /^ {2}- /.test(line)) {
      entries.push([line]);
    } else if (inFiles && /^ {4}/.test(line)) {
      entries[entries.length - 1].push(line);
    } else if (line !== '') {
      inFiles = false;
      tail.push(line);
    }
  }
  if (version === null || entries.length === 0 || tail.length === 0) {
    console.error(`merge-latest-mac: ${name} does not look like an electron-builder feed — refusing to merge it`);
    process.exit(1);
  }
  return { name, version, entries, tail };
}

const feeds = inputs.map(parse);

// One release, one version. Two feeds disagreeing means one is stale — merging them would publish a
// feed that tells half the fleet to "update" to the previous release, forever, on every check.
const versions = new Set(feeds.map((f) => f.version));
if (versions.size > 1) {
  console.error(
    `merge-latest-mac: version mismatch across feeds: ${feeds.map((f) => `${f.name}=${f.version}`).join(', ')}\n` +
      'One of these is from an older build. Rebuild the stale arch, then merge again.',
  );
  process.exit(1);
}

// Duplicate urls mean the same arch was collected twice — also a staleness smell, not a dedup job.
const seen = new Set();
for (const feed of feeds) {
  for (const entry of feed.entries) {
    const url = entry[0].replace(/^ {2}- url:/, '').trim();
    if (seen.has(url)) {
      console.error(`merge-latest-mac: ${url} appears in more than one feed — rebuild rather than merging twins`);
      process.exit(1);
    }
    seen.add(url);
  }
}

if (feeds.length === 1) {
  console.error(
    `merge-latest-mac: only ${feeds[0].name} present — emitting a single-arch feed. ` +
      'A published release should carry BOTH arches; build the other one unless this is deliberate.',
  );
}

// The tail (path / sha512 / releaseDate) is the pre-files legacy shape; current updaters read
// `files`. Take it verbatim from the first feed so the output stays a superset of a real emission.
const merged = [
  `version: ${feeds[0].version}`,
  'files:',
  ...feeds.flatMap((f) => f.entries.flat()),
  ...feeds[0].tail,
  '',
].join('\n');

writeFileSync(join(releaseDir, 'latest-mac.yml'), merged);
console.log(
  `merged ${feeds.map((f) => f.name).join(' + ')} -> release/latest-mac.yml (${seen.size} file entr${seen.size === 1 ? 'y' : 'ies'})`,
);
