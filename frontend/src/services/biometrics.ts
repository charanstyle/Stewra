import * as LocalAuthentication from 'expo-local-authentication';

/**
 * The device-owner check used to gate approving an email from a notification.
 *
 * `unavailable` is NOT a failure — it means the device has no biometric enrolled and no passcode, so
 * there is no stronger proof of "it's you" to ask for. See `confirmDeviceOwner` for why that is
 * reported rather than treated as a denial.
 */
export type IdentityCheck = 'passed' | 'failed' | 'unavailable';

/**
 * Ask the OS to confirm the device owner (fingerprint / face, falling back to the device passcode).
 *
 * WHY THIS EXISTS. The app's JWT already proves "this device is signed in as Robin". It does not prove
 * a *person* is holding the phone right now — and the residual risk this feature documents is exactly
 * that: someone with your unlocked phone. So approving a send asks the OS to re-check the owner.
 *
 * `disableDeviceFallback: false` is deliberate: a passcode is a perfectly good owner check, and refusing
 * it would lock out anyone who hasn't enrolled a fingerprint.
 *
 * Never throws — a thrown auth error must not strand the user on a screen with an undecided draft.
 */
export async function confirmDeviceOwner(promptMessage: string): Promise<IdentityCheck> {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    // No biometric AND no passcode configured. We cannot ask for a factor the device does not have.
    if (!hasHardware || !isEnrolled) {
      return 'unavailable';
    }
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      disableDeviceFallback: false,
    });
    return result.success ? 'passed' : 'failed';
  } catch {
    // Treat an unexpected auth error as a denial, not a pass. Failing closed is the only safe default
    // for a check whose entire job is to stand between a draft and an irreversible send.
    return 'failed';
  }
}
