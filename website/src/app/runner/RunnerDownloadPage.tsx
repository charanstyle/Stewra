import React, { useMemo, useState } from 'react';
import styles from './RunnerDownloadPage.module.css';

// Public download page for the Stewra Runner (and the WhatsApp Bridge). This is the target of the
// backend's RUNNER_DOWNLOAD_URL (https://www.stewra.com/runner): a user opens it on the machine they
// want to host coding agents on, grabs the single-file binary, and pairs it with a code from Activity.
//
// Big binaries live on GitHub Releases (the right home for 100MB+ artifacts), not in the SPA bundle.
// The `releases/latest/download/<asset>` form always resolves to the newest published release, so this
// page never has to know the current version tag.

// The project's release repository. Documented external resource, not app config.
const RELEASES = 'https://github.com/charanstyle/Stewra/releases'; // hardcode-ok: public release repo
const asset = (name: string): string => `${RELEASES}/latest/download/${name}`;

type OsId = 'linux' | 'mac' | 'windows';

interface Download {
  readonly label: string;
  readonly href: string;
  readonly note?: string;
}

interface OsBlock {
  readonly id: OsId;
  readonly name: string;
  readonly icon: React.JSX.Element;
  readonly runner: readonly Download[];
  readonly bridge: readonly Download[];
}

const LinuxIcon = (
  <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true">
    <path d="M12 2c-2 0-3 1.7-3 4 0 1.3.4 2.3.4 3.2 0 .9-1 1.9-1.8 3.3C6.6 14 5.6 15.6 5.6 17c0 .9.5 1.5 1.3 1.9-.1.4 0 .8.3 1.1.6.6 1.8.5 2.6.2.7.4 1.5.6 2.2.6s1.5-.2 2.2-.6c.8.3 2 .4 2.6-.2.3-.3.4-.7.3-1.1.8-.4 1.3-1 1.3-1.9 0-1.4-1-3-2-5.3-.8-1.4-1.8-2.4-1.8-3.3 0-.9.4-1.9.4-3.2 0-2.3-1-4-3-4zm-1.6 4.2c.4 0 .7.4.7.9s-.3.9-.7.9-.7-.4-.7-.9.3-.9.7-.9zm3.2 0c.4 0 .7.4.7.9s-.3.9-.7.9-.7-.4-.7-.9.3-.9.7-.9z" />
  </svg>
);

const AppleIcon = (
  <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true">
    <path d="M16 1.5c.1 1-.3 2-1 2.8-.7.8-1.7 1.3-2.7 1.2-.1-1 .4-2 1-2.7.7-.8 1.8-1.3 2.7-1.3zM19 17.3c-.5 1.1-.7 1.6-1.3 2.6-.9 1.4-2.1 3.1-3.6 3.1-1.3 0-1.7-.9-3.5-.8-1.8 0-2.2.8-3.5.8-1.5 0-2.7-1.6-3.6-2.9C1 15.9.9 11.4 2.5 9c1-1.5 2.6-2.4 4.1-2.4 1.5 0 2.5.9 3.7.9 1.2 0 1.9-.9 3.7-.9 1.3 0 2.7.7 3.7 2-3.2 1.8-2.7 6.4 1.3 6.7z" />
  </svg>
);

const WindowsIcon = (
  <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true">
    <path d="M3 5.5 10.5 4.5v7H3v-6zM11.5 4.3 21 3v8.5h-9.5v-7.2zM3 12.5h7.5v7L3 18.5v-6zM11.5 12.5H21V21l-9.5-1.3v-7.2z" />
  </svg>
);

const OSES: readonly OsBlock[] = [
  {
    id: 'linux',
    name: 'Linux',
    icon: LinuxIcon,
    runner: [{ label: 'Runner (x64)', href: asset('stewra-runner-linux-x64') }],
    bridge: [
      { label: 'Bridge · AppImage', href: asset('Stewra-Bridge-x86_64.AppImage') },
      { label: 'Bridge · .deb', href: asset('stewra-bridge-amd64.deb') },
    ],
  },
  {
    id: 'mac',
    name: 'macOS',
    icon: AppleIcon,
    runner: [
      { label: 'Runner (Apple Silicon)', href: asset('stewra-runner-macos-arm64') },
      { label: 'Runner (Intel)', href: asset('stewra-runner-macos-x64') },
    ],
    bridge: [{ label: 'Bridge · .dmg', href: asset('Stewra-Bridge.dmg') }],
  },
  {
    id: 'windows',
    name: 'Windows',
    icon: WindowsIcon,
    runner: [{ label: 'Runner (x64)', href: asset('stewra-runner-win-x64.exe') }],
    bridge: [{ label: 'Bridge · Setup', href: asset('Stewra-Bridge-Setup.exe') }],
  },
];

/** Best-guess the visitor's OS so we can lead with the right download. */
function detectOs(): OsId {
  if (typeof navigator === 'undefined') {
    return 'linux';
  }
  const ua = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (ua.includes('win')) {
    return 'windows';
  }
  if (ua.includes('mac') || ua.includes('iphone') || ua.includes('ipad')) {
    return 'mac';
  }
  return 'linux';
}

const RunnerDownloadPage: React.FC = () => {
  const detected = useMemo(detectOs, []);
  const [os, setOs] = useState<OsId>(detected);
  // Instructions point at THIS server's origin — correct for stewra.com and for any self-hoster,
  // and never a hardcoded hostname.
  const apiUrl = typeof window !== 'undefined' ? window.location.origin : 'https://www.stewra.com';
  const active = OSES.find((o) => o.id === os) ?? OSES[0];

  const runCmd =
    os === 'windows'
      ? `set STEWRA_API_URL=${apiUrl}\nstewra-runner-win-x64.exe pair <code>\nstewra-runner-win-x64.exe run`
      : `chmod +x stewra-runner-*\nSTEWRA_API_URL=${apiUrl} ./stewra-runner-* pair <code>\nSTEWRA_API_URL=${apiUrl} ./stewra-runner-* run`;

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <h1 className={styles.title}>Run coding agents on your own machine</h1>
        <p className={styles.subtitle}>
          The <strong>Stewra Runner</strong> is a single, self-contained program you run on a computer you
          own. It hosts Claude Code, Codex, and Gemini CLI against your real repositories and dials out to
          Stewra over a revocable, per-device token — no inbound ports, no cloud access to your files.
        </p>
      </header>

      <div className={styles.tabs} role="tablist" aria-label="Operating system">
        {OSES.map((o) => (
          <button
            key={o.id}
            role="tab"
            aria-selected={o.id === os}
            className={o.id === os ? `${styles.tab} ${styles.tabActive}` : styles.tab}
            onClick={() => setOs(o.id)}
          >
            <span className={styles.tabIcon}>{o.icon}</span>
            {o.name}
            {o.id === detected ? <span className={styles.detected}>detected</span> : null}
          </button>
        ))}
      </div>

      <section className={styles.card}>
        <h2 className={styles.cardHeading}>{active.name} downloads</h2>
        <div className={styles.group}>
          <span className={styles.groupLabel}>Runner</span>
          <div className={styles.buttons}>
            {active.runner.map((d) => (
              <a key={d.href} className={styles.download} href={d.href} rel="noreferrer">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {d.label}
              </a>
            ))}
          </div>
        </div>
        <div className={styles.group}>
          <span className={styles.groupLabel}>WhatsApp Bridge</span>
          <div className={styles.buttons}>
            {active.bridge.map((d) => (
              <a key={d.href} className={styles.downloadSecondary} href={d.href} rel="noreferrer">
                {d.label}
              </a>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardHeading}>Pair it</h2>
        <ol className={styles.steps}>
          <li>
            Open <a href="/activity">Activity → Runners</a> in Stewra and copy a pairing code.
          </li>
          <li>In a terminal where you downloaded the runner, run:</li>
        </ol>
        <pre className={styles.code}>{runCmd}</pre>
        <p className={styles.hint}>
          The runner comes online in Activity → Runners the moment it pairs. Revoke it there any time.
        </p>
      </section>

      <footer className={styles.footer}>
        <a href={RELEASES} rel="noreferrer">
          All releases, checksums &amp; other platforms →
        </a>
      </footer>
    </div>
  );
};

export default RunnerDownloadPage;
