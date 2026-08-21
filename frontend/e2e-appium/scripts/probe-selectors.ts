// How does React Native's `testID` surface to Appium on each platform?
//
// Maestro's `id:` selector matched resource-id *and* accessibility-id, so the old flows never had
// to say which one RN emits. WebdriverIO selectors are explicit — `~foo` is accessibility-id
// (content-desc on Android, accessibilityIdentifier on iOS), while an Android resource-id needs a
// UiSelector — so the port needs the measured answer, not a guess that silently matches nothing.
//
// A development aid, not a test. Run it against a live device and read the dump:
//
//   node scripts/probe-selectors.ts android <adb-serial>
//   node scripts/probe-selectors.ts ios <udid>
import { newSession, openApp } from '../lib/session.ts';
import type { Platform } from '../lib/devices.ts';

const [platform, udid] = process.argv.slice(2);
if (platform !== 'android' && platform !== 'ios') {
  throw new Error('usage: probe-selectors.ts <android|ios> <udid>');
}
if (!udid) {
  throw new Error('usage: probe-selectors.ts <android|ios> <udid>');
}

const driver = await newSession({
  platform: platform satisfies Platform,
  udid,
  label: udid,
  wireless: true,
});

await openApp(driver, platform);
const src = await driver.getPageSource();

const attr = (tag: string, name: string): string =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? '';

const nodes = [...src.matchAll(/<[^>]+?>/g)]
  .map((m) => m[0])
  .map((tag) => ({
    resourceId: attr(tag, 'resource-id'),
    contentDesc: attr(tag, 'content-desc'),
    name: attr(tag, 'name'),
    label: attr(tag, 'label'),
    text: attr(tag, 'text'),
    type: attr(tag, 'type') || /^<([\w.]+)/.exec(tag)?.[1] || '',
  }))
  .filter((n) => n.resourceId || n.contentDesc || n.name || n.label);

console.log(`platform: ${platform}   udid: ${udid}`);
console.log(`identified nodes: ${nodes.length}\n`);
for (const n of nodes) {
  const parts: string[] = [];
  if (n.resourceId) parts.push(`resource-id=${JSON.stringify(n.resourceId)}`);
  if (n.contentDesc) parts.push(`content-desc=${JSON.stringify(n.contentDesc)}`);
  if (n.name) parts.push(`name=${JSON.stringify(n.name)}`);
  if (n.label) parts.push(`label=${JSON.stringify(n.label)}`);
  if (n.text) parts.push(`text=${JSON.stringify(n.text)}`);
  console.log(`  ${parts.join('  ')}   [${n.type}]`);
}

await driver.deleteSession();
