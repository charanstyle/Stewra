import { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router';
import { AuthProvider, ProtectedRoute } from './hooks/useAuth';
import { CallProvider } from './hooks/CallContext';
import { IncomingCallModal } from './components/call/IncomingCallModal';
import { CallScreen } from './components/call/CallScreen';
import { ContactNotifier } from './components/ContactNotifier/ContactNotifier';
import LoginPage from './app/login/LoginPage';
import VerifyEmailPage from './app/verify/VerifyEmailPage';
import TodayPage from './app/today/TodayPage';

/**
 * Everything below the first screen is code-split.
 *
 * Login, the verify gate and Today are what a session actually starts on, so they stay in the entry
 * chunk. The rest are pages a user navigates to later — keeping them there was pushing the single
 * bundle past 500 kB, which is a real cost on a first load and was already being warned about before
 * the commerce pages existed.
 */
const ActivityPage = lazy(() => import('./app/activity/ActivityPage'));
const MemoryPage = lazy(() => import('./app/memory/MemoryPage'));
const ChatsPage = lazy(() => import('./app/chats/ChatsPage'));
const ConversationPage = lazy(() => import('./app/chats/ConversationPage'));
const ContactsPage = lazy(() => import('./app/contacts/ContactsPage'));
const StewraPage = lazy(() => import('./app/stewra/StewraPage'));
const SettingsPage = lazy(() => import('./app/settings/SettingsPage'));
const RunnerDownloadPage = lazy(() => import('./app/runner/RunnerDownloadPage'));
const GithubSetupPage = lazy(() => import('./app/github/GithubSetupPage'));
const CommercePage = lazy(() => import('./app/commerce/CommercePage'));
const AudiencePage = lazy(() => import('./app/commerce/AudiencePage'));
const CampaignsPage = lazy(() => import('./app/commerce/CampaignsPage'));
const TeamPage = lazy(() => import('./app/commerce/TeamPage'));
const InviteAcceptPage = lazy(() => import('./app/commerce/InviteAcceptPage'));
const PrivacyPage = lazy(() => import('./app/legal/PrivacyPage'));
const TermsPage = lazy(() => import('./app/legal/TermsPage'));

export default function App(): React.JSX.Element {
  return (
    <AuthProvider>
      <CallProvider>
        {/* `null` rather than a spinner: these chunks are small and same-origin, so a flash of a
            loading state on every navigation would be more visible than the load itself. */}
        <Suspense fallback={null}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            {/* Public: the RUNNER_DOWNLOAD_URL target — opened on the machine that will host agents. */}
            <Route path="/runner" element={<RunnerDownloadPage />} />
            {/* The GitHub App's Setup URL target — GitHub redirects here after a click-through install. */}
            <Route
              path="/github/setup"
              element={
                <ProtectedRoute>
                  <GithubSetupPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/verify-email"
              element={
                <ProtectedRoute>
                  <VerifyEmailPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/today"
              element={
                <ProtectedRoute>
                  <TodayPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/activity"
              element={
                <ProtectedRoute>
                  <ActivityPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/memory"
              element={
                <ProtectedRoute>
                  <MemoryPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/chats"
              element={
                <ProtectedRoute>
                  <ChatsPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/chats/:id"
              element={
                <ProtectedRoute>
                  <ConversationPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/contacts"
              element={
                <ProtectedRoute>
                  <ContactsPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/stewra"
              element={
                <ProtectedRoute>
                  <StewraPage />
                </ProtectedRoute>
              }
            />
            {/* The commerce plane's fallback surface. Texting Stewra is the headline; this is for what
              a chat thread is bad at — seeing every thread at once, and Meta's browser-only signup. */}
            <Route
              path="/commerce"
              element={
                <ProtectedRoute>
                  <CommercePage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/commerce/audience"
              element={
                <ProtectedRoute>
                  <AudiencePage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/commerce/campaigns"
              element={
                <ProtectedRoute>
                  <CampaignsPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/commerce/team"
              element={
                <ProtectedRoute>
                  <TeamPage />
                </ProtectedRoute>
              }
            />
            {/* Where the org-invite email lands. NOT inside ProtectedRoute: its redirect to /login
              drops the query string, and the token in it is the entire invite. The page gates
              itself and hands /login a `next` back here. */}
            <Route path="/invites/accept" element={<InviteAcceptPage />} />
            <Route
              path="/settings"
              element={
                <ProtectedRoute>
                  <SettingsPage />
                </ProtectedRoute>
              }
            />
            {/* Public, and deliberately NOT inside ProtectedRoute. Meta's App Review opens the
              privacy policy logged out, and "the URL redirects to a sign-in screen" is one of the
              most common review rejections. They also have to sit above the catch-all below, which
              would otherwise send /privacy to /today and straight into the auth gate. */}
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="*" element={<Navigate to="/today" replace />} />
          </Routes>
        </Suspense>
        {/* Call surfaces + contact banners render above the router so they persist across navigation. */}
        <ContactNotifier />
        <IncomingCallModal />
        <CallScreen />
      </CallProvider>
    </AuthProvider>
  );
}
