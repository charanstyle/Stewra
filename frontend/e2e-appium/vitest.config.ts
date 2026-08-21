import { defineConfig } from 'vitest/config';

// Real devices, one Appium server, no mocks. The defaults Vitest ships are tuned for fast unit
// tests and are all wrong here, so every override below is deliberate.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],

    // One test file at a time. Files share the Appium server and, more importantly, the physical
    // phones — two files driving one handset at once interleave taps and produce failures that
    // look like app bugs.
    fileParallelism: false,

    // A device session can take minutes to establish (WebDriverAgent build on iOS, uiautomator2
    // server install on Android). Per-test overrides tighten this where a step should be quick.
    testTimeout: 300_000,
    hookTimeout: 300_000,

    // No retries. A test that passes on the second attempt is a test that failed, and a suite that
    // hides that is worse than no suite — the flake is the finding.
    retry: 0,

    reporters: ['verbose'],
  },
});
