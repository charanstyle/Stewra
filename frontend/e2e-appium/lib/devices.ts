// Which real devices are attached right now.
//
// Deliberately *discovered*, never listed in a config file. Wi-Fi addresses move when a lease
// changes or a phone re-associates, and a stale hardcoded address fails as "element not found"
// several minutes into a run instead of "that device is not here". Discovery makes the device set
// a fact about the machine at run time.
//
// Android comes from adb (which carries both USB serials and wireless `host:port` targets
// identically). iOS comes from the xcuitest driver's own lister, which reads usbmuxd — the same
// source Appium uses to open the session, so if the lister cannot see a phone, neither can a test.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type Platform = 'android' | 'ios';

export interface Device {
  readonly platform: Platform;
  /** adb serial on Android — a USB serial, or a `host:port` pair when wireless. UDID on iOS. */
  readonly udid: string;
  /** Human label for test names — model where the tool gives us one, else the udid. */
  readonly label: string;
  /** True when the adb serial is a `host:port` wireless target rather than a USB serial. */
  readonly wireless: boolean;
}

/**
 * Attached Android devices, from `adb devices -l`.
 *
 * Only devices in state `device` are returned: `offline`, `unauthorized` and `no permissions`
 * entries are real problems that must surface as "no device" rather than be silently driven.
 */
export async function androidDevices(): Promise<Device[]> {
  const { stdout } = await run('adb', ['devices', '-l']);
  const listed = stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const fields = line.split(/\s+/);
      const udid = fields[0] ?? '';
      const state = fields[1] ?? '';
      const model = /\bmodel:(\S+)/.exec(fields.slice(2).join(' '))?.[1];
      return { udid, state, model };
    })
    .filter((d) => d.state === 'device' && d.udid.length > 0)
    .map((d) => ({
      platform: 'android' as const,
      udid: d.udid,
      label: d.model ? `${d.model.replace(/_/g, ' ')} (${d.udid})` : d.udid,
      wireless: /:\d+$/.test(d.udid),
    }));

  // A phone that is plugged in *and* has a wireless target appears twice, under two different
  // serials. Left alone it is driven twice per run — the same handset, reported as two devices,
  // so a real single-device failure reads as "1 of 2 devices failed". Collapse by hardware serial.
  //
  // The wireless entry wins: a cable is transient and gets unplugged mid-suite, while the
  // reserved address is stable. Which one survives is logged rather than silent.
  const byHardwareSerial = new Map<string, Device>();
  for (const device of listed) {
    const { stdout: serial } = await run('adb', ['-s', device.udid, 'shell', 'getprop', 'ro.serialno']);
    const key = serial.trim();
    const existing = byHardwareSerial.get(key);
    if (!existing) {
      byHardwareSerial.set(key, device);
      continue;
    }
    const [keep, drop] = device.wireless ? [device, existing] : [existing, device];
    byHardwareSerial.set(key, keep);
    console.log(`[devices] ${key} is attached twice; using ${keep.udid}, ignoring ${drop.udid}`);
  }
  return [...byHardwareSerial.values()];
}

/**
 * Real iOS devices visible to Appium, from `appium driver run xcuitest list-real-devices`.
 *
 * That command speaks to usbmuxd. A phone only appears over Wi-Fi once "Connect via network" has
 * been ticked for it in Xcode → Window → Devices and Simulators; without that it is USB-only, no
 * matter how reachable it is by IP. The lister prints a JSON block after its log lines.
 */
export async function iosDevices(): Promise<Device[]> {
  const { stdout, stderr } = await run('appium', [
    'driver',
    'run',
    'xcuitest',
    'list-real-devices',
  ]);
  const combined = `${stdout}\n${stderr}`;

  // The lister prefixes every line with `info Lister `. Strip that, then take the JSON object.
  const cleaned = combined
    .split('\n')
    .map((line) => line.replace(/^\s*(info|warn|error)\s+Lister\s?/, ''))
    .join('\n');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(
      `xcuitest list-real-devices printed no JSON block; cannot tell which iPhones are attached.\n${combined}`,
    );
  }
  const parsed = JSON.parse(cleaned.slice(start, end + 1));

  const listed: unknown = parsed.devices;
  if (!Array.isArray(listed)) return [];

  return listed.map((entry) => {
    const d = entry;
    const udid = String(d.udid ?? d.UniqueDeviceID ?? d.id ?? '');
    if (udid.length === 0) {
      throw new Error(`xcuitest lister returned a device with no udid: ${JSON.stringify(entry)}`);
    }
    const name = d.name === undefined ? undefined : String(d.name);
    return {
      platform: 'ios' as const,
      udid,
      label: name ? `${name} (${udid})` : udid,
      wireless: true,
    };
  });
}

/** Everything attached, both platforms. */
export async function allDevices(): Promise<Device[]> {
  const [android, ios] = await Promise.all([androidDevices(), iosDevices()]);
  return [...android, ...ios];
}
