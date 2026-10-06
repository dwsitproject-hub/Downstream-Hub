import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Admin from './pages/Admin';
import ChangePasswordExpired from './pages/ChangePasswordExpired';
import ChangePassword from './pages/ChangePassword';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import MagicLinkLogin from './pages/MagicLinkLogin';
import ActivateAccount from './pages/ActivateAccount';
import ActivityTracker from './components/ActivityTracker';

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ padding: 24, textAlign: 'center' }}>Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/activate" element={<ActivateAccount />} />
      <Route path="/magic-link-login" element={<MagicLinkLogin />} />
      <Route path="/change-password-expired" element={<ChangePasswordExpired />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        }
      />
      <Route path="/change-password" element={<ProtectedRoute><ChangePassword /></ProtectedRoute>} />
      <Route path="/admin" element={<ProtectedRoute><Navigate to="/admin/domains" replace /></ProtectedRoute>} />
      <Route path="/admin/:section" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ActivityTracker />
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
