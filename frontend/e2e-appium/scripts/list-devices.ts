// What would the suite run against right now?
//
// The first thing to check when a run reports the wrong number of devices, and the fastest way to
// confirm a phone came back after a reboot. Same discovery the tests use — not a second
// implementation that could disagree with them.
import { androidDevices, iosDevices } from '../lib/devices.ts';

const [android, ios] = await Promise.all([androidDevices(), iosDevices()]);

console.log(`Android (${android.length})`);
for (const d of android) {
  console.log(`  ${d.udid.padEnd(24)} ${d.wireless ? 'wireless' : 'usb     '}  ${d.label}`);
}

console.log(`\niOS (${ios.length})`);
for (const d of ios) {
  console.log(`  ${d.udid.padEnd(24)} ${d.label}`);
}
if (ios.length === 0) {
  console.log(
    '  none. Appium finds iPhones through usbmuxd, which only carries a device over the\n' +
      '  network once "Connect via network" is ticked for it in\n' +
      '  Xcode > Window > Devices and Simulators. Without that it is USB-only.',
  );
}
