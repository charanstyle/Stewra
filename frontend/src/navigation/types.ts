import type { CallKind } from '@stewra/shared-types';

/**
 * A single flat stack param list for the whole app. RootNavigator swaps which
 * screens are registered based on auth state (unauthenticated: Login/Register/
 * VerifyEmail; authenticated: everything else) rather than nesting two
 * navigators, which keeps navigation typing and the global `navigationRef`
 * (used by voipCallService to jump straight to Call on a CallKit answer) simple.
 */
export interface RootStackParamList {
  Login: undefined;
  Register: undefined;
  VerifyEmail: undefined;
  ChatList: undefined;
  Conversation: { readonly conversationId: string; readonly title: string };
  Contacts: undefined;
  StewraVoice: undefined;
  Call: {
    readonly conversationId: string;
    readonly callKind: CallKind;
    readonly direction: 'incoming' | 'outgoing';
    readonly peerName: string;
  };
  [key: string]: object | undefined;
}
