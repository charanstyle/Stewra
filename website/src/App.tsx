import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, ProtectedRoute } from './hooks/useAuth';
import LoginPage from './app/login/LoginPage';
import VerifyEmailPage from './app/verify/VerifyEmailPage';
import ActivityPage from './app/activity/ActivityPage';
import MemoryPage from './app/memory/MemoryPage';

export default function App(): React.JSX.Element {
  return (
    <AuthProvider>
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
        <Route path="*" element={<Navigate to="/activity" replace />} />
      </Routes>
    </AuthProvider>
  );
}
