import { describe, it, expect } from 'vitest';
import { loadRunnerConfig } from '../config.js';

describe('loadRunnerConfig', () => {
  it('accepts a valid API URL and version', () => {
    const config = loadRunnerConfig({ STEWRA_API_URL: 'https://www.stewra.com' }, '0.1.0');
    expect(config.apiBaseUrl).toBe('https://www.stewra.com');
    expect(config.appVersion).toBe('0.1.0');
  });

  it('throws loudly when STEWRA_API_URL is missing — no silent default', () => {
    expect(() => loadRunnerConfig({}, '0.1.0')).toThrowError(/STEWRA_API_URL/);
  });

  it('throws when STEWRA_API_URL is not a URL', () => {
    expect(() => loadRunnerConfig({ STEWRA_API_URL: 'not-a-url' }, '0.1.0')).toThrowError(
      /misconfigured/,
    );
  });

  it('rejects a non-semver app version', () => {
    expect(() => loadRunnerConfig({ STEWRA_API_URL: 'https://www.stewra.com' }, 'v1')).toThrowError(
      /misconfigured/,
    );
  });
});
