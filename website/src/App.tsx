import { Routes, Route, Navigate } from 'react-router';
import { AuthProvider, ProtectedRoute } from './hooks/useAuth';
import { CallProvider } from './hooks/CallContext';
import { IncomingCallModal } from './components/call/IncomingCallModal';
import { CallScreen } from './components/call/CallScreen';
import { ContactNotifier } from './components/ContactNotifier/ContactNotifier';
import LoginPage from './app/login/LoginPage';
import VerifyEmailPage from './app/verify/VerifyEmailPage';
import TodayPage from './app/today/TodayPage';
import ActivityPage from './app/activity/ActivityPage';
import MemoryPage from './app/memory/MemoryPage';
import ChatsPage from './app/chats/ChatsPage';
import ConversationPage from './app/chats/ConversationPage';
import ContactsPage from './app/contacts/ContactsPage';
import StewraPage from './app/stewra/StewraPage';
import SettingsPage from './app/settings/SettingsPage';
import RunnerDownloadPage from './app/runner/RunnerDownloadPage';
import GithubSetupPage from './app/github/GithubSetupPage';

export default function App(): React.JSX.Element {
  return (
    <AuthProvider>
      <CallProvider>
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
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <SettingsPage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/today" replace />} />
        </Routes>
        {/* Call surfaces + contact banners render above the router so they persist across navigation. */}
        <ContactNotifier />
        <IncomingCallModal />
        <CallScreen />
      </CallProvider>
    </AuthProvider>
  );
}
