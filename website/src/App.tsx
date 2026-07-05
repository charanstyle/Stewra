import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, ProtectedRoute } from './hooks/useAuth';
import { CallProvider } from './hooks/CallContext';
import { IncomingCallModal } from './components/call/IncomingCallModal';
import { CallScreen } from './components/call/CallScreen';
import { ContactNotifier } from './components/ContactNotifier/ContactNotifier';
import LoginPage from './app/login/LoginPage';
import VerifyEmailPage from './app/verify/VerifyEmailPage';
import ActivityPage from './app/activity/ActivityPage';
import MemoryPage from './app/memory/MemoryPage';
import ChatsPage from './app/chats/ChatsPage';
import ConversationPage from './app/chats/ConversationPage';
import ContactsPage from './app/contacts/ContactsPage';
import StewraPage from './app/stewra/StewraPage';

export default function App(): React.JSX.Element {
  return (
    <AuthProvider>
      <CallProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/verify-email"
            element={
              <ProtectedRoute>
                <VerifyEmailPage />
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
          <Route path="*" element={<Navigate to="/activity" replace />} />
        </Routes>
        {/* Call surfaces + contact banners render above the router so they persist across navigation. */}
        <ContactNotifier />
        <IncomingCallModal />
        <CallScreen />
      </CallProvider>
    </AuthProvider>
  );
}
