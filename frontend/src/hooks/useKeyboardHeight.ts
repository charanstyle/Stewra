import { useEffect, useState } from 'react';
import { Keyboard } from 'react-native';

/**
 * Current soft-keyboard height in px (0 while hidden).
 *
 * Screens use this to lift bottom-anchored content above the keyboard by padding their
 * container by this height. We do it manually because RN's `KeyboardAvoidingView` is a
 * no-op for this on Android under Expo edge-to-edge: the window no longer resizes for the
 * IME, so the component has nothing to react to and the content stays behind the keyboard.
 *
 * `keyboardDidShow`/`keyboardDidHide` fire on both platforms; `endCoordinates.height` is the
 * keyboard frame height the OS reports. Callers should subtract any bottom safe-area inset
 * their layout already reserves so the content sits flush above the keyboard, not gapped.
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const onShow = Keyboard.addListener('keyboardDidShow', (e) =>
      setHeight(e.endCoordinates.height),
    );
    const onHide = Keyboard.addListener('keyboardDidHide', () => setHeight(0));
    return () => {
      onShow.remove();
      onHide.remove();
    };
  }, []);

  return height;
}
