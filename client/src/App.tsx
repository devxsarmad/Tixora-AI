import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, AUTH_EXPIRED_EVENT } from './api/http.js';
import tixoraLogo from './assests/tixora-logo.jpeg';
import { getSession, login, logout, register } from './features/auth/authApi.js';
import { LoginPage } from './features/auth/pages/LoginPage.js';
import { RegisterPage } from './features/auth/pages/RegisterPage.js';
import { clearLegacySession } from './features/auth/session.js';
import type { AuthResponse } from './features/auth/types.js';
import { Workspace } from './features/workspace/Workspace.js';
import { TixoraLoader } from './components/shared/TixoraLoader.js';

type AuthMode = 'login' | 'register';
type AuthEntryPoint = 'login' | 'register' | 'restored';

function getInitialAuthMode(pathname: string): AuthMode {
  return pathname === '/register' ? 'register' : 'login';
}

function navigateTo(pathname: string, replace = false) {
  if (window.location.pathname === pathname) return;
  window.history[replace ? 'replaceState' : 'pushState']({}, '', pathname);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function App() {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<AuthResponse | null>(null);
  const [isRestoringSession, setIsRestoringSession] = useState(true);
  const [mode, setMode] = useState<AuthMode>(() => getInitialAuthMode(window.location.pathname));
  const [authEntryPoint, setAuthEntryPoint] = useState<AuthEntryPoint>('restored');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleAuth(
    action: () => Promise<AuthResponse>,
    entryPoint: AuthEntryPoint
  ) {
    setError(null);
    setIsSubmitting(true);

    try {
      const nextSession = await action();
      await queryClient.cancelQueries();
      queryClient.clear();
      setAuthEntryPoint(entryPoint);
      setSession(nextSession);
      navigateTo(entryPoint === 'register' ? '/setup' : '/board', true);
    } catch (authError) {
      setError(
        authError instanceof Error ? authError.message : 'Authentication failed'
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  function endSession(message?: string) {
    clearLegacySession();
    void queryClient.cancelQueries();
    queryClient.clear();
    setSession(null);
    setMode('login');
    setAuthEntryPoint('restored');
    setError(message ?? null);
    navigateTo('/login', true);
  }

  function updateSession(nextSession: AuthResponse) {
    setSession(nextSession);
  }

  async function handleLogout(message?: string) {
    try {
      await logout();
      endSession(typeof message === 'string' ? message : undefined);
    } catch {
      window.alert('Could not sign out. Please try again.');
    }
  }

  useEffect(() => {
    let active = true;
    clearLegacySession();
    void getSession().then((restored) => {
      if (active) setSession(restored);
    }).catch((restoreError: unknown) => {
      if (active && !(restoreError instanceof ApiError && restoreError.status === 401)) {
        setError('Could not restore your session. Please try logging in again.');
      }
    }).finally(() => { if (active) setIsRestoringSession(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    function handlePopState() {
      if (!session) {
        setMode(getInitialAuthMode(window.location.pathname));
      }
    }

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [session]);

  useEffect(() => {
    function handleAuthExpired() {
      if (isRestoringSession) return;
      endSession('Your session expired. Please log in again.');
    }

    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
  }, [queryClient, isRestoringSession]);

  useEffect(() => {
    if (session || isRestoringSession) return;
    if (window.location.pathname !== '/login' && window.location.pathname !== '/register') {
      navigateTo('/login', true);
    }
  }, [session, isRestoringSession]);

  useEffect(() => {
    if (!session) return;
    const authOrLegacyRoute = ['/login', '/register', '/workspace', '/'];
    if (authOrLegacyRoute.includes(window.location.pathname)) {
      navigateTo('/board', true);
    }
  }, [session]);

  if (isRestoringSession) return <TixoraLoader variant="full" />;

  if (session) {
    return (
      <Workspace
        key={session.user.id}
        session={session}
        entryPoint={authEntryPoint}
        onLogout={handleLogout}
        onSessionChange={updateSession}
      />
    );
  }

  return (
    <main className="auth-shell">
      <section className="auth-hero">
        <div className="auth-brand-title">
          <img src={tixoraLogo} alt="Tixora-AI logo" className="auth-logo" />
          <div>
            <p className="eyebrow">Organization Operations</p>
            <h1>Tixora-AI</h1>
          </div>
        </div>
        <p>
          Manage organizations, projects, tickets, delivery, and AI-assisted project operations in one focused app.
        </p>
      </section>

      <section className="auth-card">
        <div className="auth-tabs" role="tablist" aria-label="Authentication">
          <button
            type="button"
            className={mode === 'login' ? 'tab-button active' : 'tab-button'}
            onClick={() => {
              setMode('login');
              setError(null);
              navigateTo('/login');
            }}
          >
            Login
          </button>
          <button
            type="button"
            className={mode === 'register' ? 'tab-button active' : 'tab-button'}
            onClick={() => {
              setMode('register');
              setError(null);
              navigateTo('/register');
            }}
          >
            Register
          </button>
        </div>

        {error ? <p className="error-message">{error}</p> : null}

        {mode === 'login' ? (
          <LoginPage
            disabled={isSubmitting}
            onSubmit={(input) => handleAuth(() => login(input), 'login')}
          />
        ) : (
          <RegisterPage
            disabled={isSubmitting}
            onSubmit={(input) => handleAuth(() => register(input), 'register')}
          />
        )}
      </section>
    </main>
  );
}
