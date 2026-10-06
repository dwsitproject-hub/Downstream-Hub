import { createContext, useContext, useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { apiRequest } from '../api';

const AuthContext = createContext(null);

/** Paths where an unauthenticated visitor is expected — skip /api/auth/me to avoid noisy 401s. */
const PUBLIC_AUTH_PATHS = new Set(['/login', '/magic-link-login', '/activate', '/reset-password', '/forgot-password']);

export function AuthProvider({ children }) {
  const location = useLocation();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (PUBLIC_AUTH_PATHS.has(location.pathname)) {
      setUser(null);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    apiRequest('/api/auth/me')
      .then((data) => setUser(data.user))
      .catch(() => {
        setUser(null);
      })
      .finally(() => setLoading(false));
    return undefined;
  }, [location.pathname]);

  const login = async (email, password, extras = {}) => {
    const data = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, ...extras }),
    });
    if (data.mfa_required || data.magic_link_required) return data;
    setUser(data.user || null);
    return data;
  };

  const verifyMfa = async (challenge_id, otp) => {
    const data = await apiRequest('/api/auth/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({ challenge_id, otp }),
    });
    setUser(data.user || null);
    return data;
  };

  const loginWithMagicToken = async (rawToken) => {
    const data = await apiRequest('/api/auth/magic-link/verify', {
      method: 'POST',
      body: JSON.stringify({ token: rawToken }),
    });
    setUser(data.user || null);
    return data;
  };

  const resendMagicLink = async (email, password, pending_id, extras = {}) => {
    return apiRequest('/api/auth/magic-link/resend', {
      method: 'POST',
      body: JSON.stringify({ email, password, pending_id, ...extras }),
    });
  };

  const setSession = (_newToken, newUser) => {
    setUser(newUser || null);
  };

  const register = async (email, password, { password_retype, business_unit_id } = {}) => {
    const data = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, password_retype, business_unit_id: business_unit_id || undefined }),
    });
    setUser(data.user || null);
    return data;
  };

  const logout = async () => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{
      user, loading, login, verifyMfa, loginWithMagicToken, resendMagicLink, register, logout, setSession,
    }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
