import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, ProtectedRoute } from './hooks/useAuth';
import LoginPage from './app/login/LoginPage';
import ActivityPage from './app/activity/ActivityPage';

export default function App(): React.JSX.Element {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/activity"
          element={
            <ProtectedRoute>
              <ActivityPage />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/activity" replace />} />
      </Routes>
    </AuthProvider>
  );
}
