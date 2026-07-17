import type { CallKind } from '@stewra/shared-types';

/**
 * The three primary destinations of the authenticated app, presented as a bottom
 * tab bar. Conversation/Call are NOT tabs — they push over the tabs on the parent
 * stack (see RootStackParamList). The `[key: string]` index signature mirrors the
 * root stack's, so a tab screen can `navigation.navigate('Conversation', …)` up to
 * the parent stack without threading composite navigator generics through every
 * screen.
 */
export interface MainTabParamList {
  Chats: undefined;
  Contacts: undefined;
  StewraVoice: undefined;
  Settings: undefined;
  [key: string]: object | undefined;
}

/**
 * The root stack for the whole app. RootNavigator swaps which screens are
 * registered based on auth state (unauthenticated: Login/Register/VerifyEmail;
 * authenticated: the MainTabs bottom-tab navigator plus the Conversation/Call
 * screens that push over it). Keeping one flat stack (with MainTabs nested as a
 * single screen) keeps the global `navigationRef` — used by voipCallService to
 * jump straight to Call on a CallKit answer — simple: it still targets Call and
 * Conversation directly.
 */
export interface RootStackParamList {
  Login: undefined;
  Register: undefined;
  VerifyEmail: undefined;
  ForgotPassword: undefined;
  ResetPassword: { readonly email: string };
  MainTabs: undefined;
  Conversation: { readonly conversationId: string; readonly title: string };
  /**
   * The biometric gate for approving an email Stewra drafted, reached by tapping Approve on the
   * approval notification. Carries only the message id — the draft is fetched over the authenticated
   * session, never from the notification, so the OS never holds the email's contents.
   */
  EmailApproval: { readonly messageId: string };
  Call: {
    readonly conversationId: string;
    readonly callKind: CallKind;
    readonly direction: 'incoming' | 'outgoing';
    readonly peerName: string;
  };
  [key: string]: object | undefined;
}
