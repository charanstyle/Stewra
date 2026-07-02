const { withAppDelegate, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// Ported verbatim (structure + comments) from TrueTalk's
// frontend/plugins/withVoipAppDelegate.cjs, generalized for Stewra. Injects
// PushKit (VoIP) registration + CallKit incoming-call reporting into the
// generated AppDelegate.swift. Done as a config plugin (not a hand-edit) so it
// survives `expo prebuild --clean`.
//
// Flow: on launch we register for VoIP pushes; the token is forwarded to JS,
// which registers it with the backend (PUT /calls/push-token, platform ios).
// On an incoming VoIP push the backend sends a flat payload —
//   type=incoming_call, callId (the server-minted CallSession id),
//   conversationId, callKind, callerName — and we MUST report a call to
// CallKit synchronously before completion() on every push (iOS 13+
// requirement), then hand the payload to JS. `callId` doubles as the stable
// CallKit UUID (an incoming push and a later cancel push reference the same
// call).

const IMPORT_ANCHOR = 'import ReactAppDependencyProvider';
const IMPORT_INJECTION = `import ReactAppDependencyProvider
import PushKit
import CallKit`;

const CLASS_ANCHOR = 'public class AppDelegate: ExpoAppDelegate {';
const CLASS_INJECTION = 'public class AppDelegate: ExpoAppDelegate, PKPushRegistryDelegate {';

const REGISTER_ANCHOR =
  '    return super.application(application, didFinishLaunchingWithOptions: launchOptions)';
const REGISTER_INJECTION = `    // Register for VoIP (PushKit) pushes so the app can ring via CallKit even
    // when killed/backgrounded. The token is forwarded to JS, which registers it
    // with the backend (PUT /calls/push-token, platform ios).
    RNVoipPushNotificationManager.voipRegistration()

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)`;

const METHODS_ANCHOR = '  // Linking API';
const METHODS_INJECTION = `  // MARK: - PushKit (VoIP)

  public func pushRegistry(
    _ registry: PKPushRegistry,
    didUpdate pushCredentials: PKPushCredentials,
    for type: PKPushType
  ) {
    RNVoipPushNotificationManager.didUpdate(pushCredentials, forType: type.rawValue)
  }

  public func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    let dict = payload.dictionaryPayload

    // callId is the server-minted CallSession id, so it doubles as the CallKit
    // call UUID: an incoming push and its later cancel push reference the same
    // call.
    let uuid = (dict["callId"] as? String) ?? UUID().uuidString
    var enriched = dict
    enriched["uuid"] = uuid

    let pushType = (dict["type"] as? String) ?? "incoming_call"
    let callKind = (dict["callKind"] as? String) ?? "audio"
    let hasVideo = callKind == "video"
    let callerName = (dict["callerName"] as? String) ?? "Incoming call"
    let handle = (dict["conversationId"] as? String) ?? uuid

    // Hand the push to JS (fires the \`notification\` event with the payload).
    RNVoipPushNotificationManager.didReceiveIncomingPush(with: payload, forType: type.rawValue)

    // iOS 13+ REQUIRES reporting an incoming call to CallKit synchronously on
    // EVERY VoIP push, before completion(), or the app is terminated and future
    // VoIP pushes are throttled. So even a "call cancelled" push must report a
    // call first, then immediately end it.
    RNCallKeep.reportNewIncomingCall(
      uuid,
      handle: handle,
      handleType: "generic",
      hasVideo: hasVideo,
      localizedCallerName: callerName,
      supportsHolding: true,
      supportsDTMF: true,
      supportsGrouping: true,
      supportsUngrouping: true,
      fromPushKit: true,
      payload: enriched,
      withCompletionHandler: completion
    )

    if pushType == "call_cancelled" {
      // The call was missed/cancelled before this device answered. End the call
      // we just reported with reason 3 (CXCallEndedReason.unanswered) so CallKit
      // stops ringing and logs it as a missed call.
      RNCallKeep.endCall(withUUID: uuid, reason: 3)
    }
  }

  // Linking API`;

// The injected Swift code calls into two Objective-C pods (RNVoipPushNotification,
// RNCallKeep). Swift can only see Obj-C classes that are exposed through the
// target's bridging header, so without these imports the AppDelegate fails to
// compile with "cannot find 'RNVoipPushNotificationManager'/'RNCallKeep' in
// scope". Expo generates an empty bridging header; we append the imports here so
// the fix survives `expo prebuild --clean`.
const BRIDGING_IMPORTS = [
  '#import <RNVoipPushNotification/RNVoipPushNotificationManager.h>',
  '#import <RNCallKeep/RNCallKeep.h>',
];

function withVoipBridgingHeader(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const projectName = cfg.modRequest.projectName;
      if (!projectName) {
        throw new Error(
          'withVoipAppDelegate: could not resolve iOS projectName for the bridging header'
        );
      }
      const headerPath = path.join(
        cfg.modRequest.platformProjectRoot,
        projectName,
        `${projectName}-Bridging-Header.h`
      );
      if (!fs.existsSync(headerPath)) {
        throw new Error(
          `withVoipAppDelegate: bridging header not found at ${headerPath}`
        );
      }
      const current = fs.readFileSync(headerPath, 'utf8');
      const missing = BRIDGING_IMPORTS.filter((imp) => !current.includes(imp));
      if (missing.length > 0) {
        fs.writeFileSync(headerPath, `${current.trimEnd()}\n${missing.join('\n')}\n`);
      }
      return cfg;
    },
  ]);
}

module.exports = function withVoipAppDelegate(config) {
  const withSwift = (cfg) =>
    withAppDelegate(cfg, (c) => {
      if (c.modResults.language !== 'swift') {
        throw new Error(
          `withVoipAppDelegate: expected a Swift AppDelegate, got ${c.modResults.language}`
        );
      }

      let contents = c.modResults.contents;

      // Idempotent: if already conformed, assume the whole injection ran.
      if (contents.includes('PKPushRegistryDelegate')) {
        return c;
      }

      for (const [anchor, injection] of [
        [IMPORT_ANCHOR, IMPORT_INJECTION],
        [CLASS_ANCHOR, CLASS_INJECTION],
        [REGISTER_ANCHOR, REGISTER_INJECTION],
        [METHODS_ANCHOR, METHODS_INJECTION],
      ]) {
        if (!contents.includes(anchor)) {
          throw new Error(
            `withVoipAppDelegate: anchor not found in AppDelegate.swift: ${JSON.stringify(
              anchor
            )}`
          );
        }
        contents = contents.replace(anchor, injection);
      }

      c.modResults.contents = contents;
      return c;
    });

  return withVoipBridgingHeader(withSwift(config));
};
