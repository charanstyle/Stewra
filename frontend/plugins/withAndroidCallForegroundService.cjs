const { withAndroidManifest } = require('@expo/config-plugins');

// Ported verbatim from TrueTalk's frontend/plugins/withAndroidCallForegroundService.cjs.
// Stewra runs ONE foreground service: IncomingCallRingService (declared by
// withAndroidNotificationAvatar) rings for an incoming call. It uses the
// `shortService` type, so the app needs FOREGROUND_SERVICE +
// FOREGROUND_SERVICE_SHORT_SERVICE.
//
// FOREGROUND_SERVICE_MEDIA_PLAYBACK is stripped: it is contributed only by a
// transitive native AAR (the WebRTC/audio stack), nothing starts a
// media-playback foreground service, and it wrongly implies a background media
// player on the Play listing.
const PERMISSIONS_TO_ADD = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_SHORT_SERVICE',
  // Required for the incoming-call notification's full-screen intent to present
  // the call UI over the lock screen on Android 10+. (On Android 14+ the runtime
  // appop must also be granted — handled in-app via canUseFullScreenIntent.)
  'android.permission.USE_FULL_SCREEN_INTENT',
];
const PERMISSIONS_TO_REMOVE = [
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
];

module.exports = function withAndroidCallForegroundService(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;

    // The tools namespace is required for tools:node="remove" below.
    manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';

    if (!Array.isArray(manifest['uses-permission'])) {
      manifest['uses-permission'] = [];
    }

    for (const name of PERMISSIONS_TO_ADD) {
      // Idempotent: drop any prior copy (including a stale remove stub) before
      // declaring it cleanly.
      manifest['uses-permission'] = manifest['uses-permission'].filter(
        (perm) => perm.$?.['android:name'] !== name
      );
      manifest['uses-permission'].push({
        $: { 'android:name': name },
      });
    }

    for (const name of PERMISSIONS_TO_REMOVE) {
      // Drop any direct declaration first (idempotent), then emit a remove stub
      // so the merger also deletes the library-provided copy.
      manifest['uses-permission'] = manifest['uses-permission'].filter(
        (perm) => perm.$?.['android:name'] !== name
      );
      manifest['uses-permission'].push({
        $: { 'android:name': name, 'tools:node': 'remove' },
      });
    }

    // The incoming-call full-screen intent launches MainActivity. Without these
    // flags a full-screen-intent activity started while the screen is off neither
    // wakes the screen nor draws over the keyguard, so the ring silently degrades
    // to a heads-up notification. These make MainActivity present full-screen over
    // the lock screen (the effect only applies when it is launched while locked —
    // normal taps happen with the device already unlocked).
    const application = manifest.application?.[0];
    const mainActivity = application?.activity?.find(
      (activity) => activity.$?.['android:name'] === '.MainActivity'
    );
    if (!mainActivity) {
      throw new Error(
        'withAndroidCallForegroundService: .MainActivity not found in manifest; ' +
          'cannot enable full-screen incoming-call UI over the lock screen.'
      );
    }
    mainActivity.$['android:showWhenLocked'] = 'true';
    mainActivity.$['android:turnScreenOn'] = 'true';

    return cfg;
  });
};
