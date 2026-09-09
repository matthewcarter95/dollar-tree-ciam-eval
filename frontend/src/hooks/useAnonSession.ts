import { useEffect, useRef, useState } from 'react';

const SESSION_TOKEN_KEY = 'dt_anon_session_token';
export const ANON_SUB_KEY = 'dt_anon_sub';

export interface AnonSession {
  accessToken: string | null;
  loading: boolean;
  error: string | null;
}

/**
 * Obtains and refreshes an anonymous session access token.
 *
 * - Persists the session_token in localStorage so the same anonymous identity
 *   is restored across page refreshes.
 * - The access_token is kept in memory only (short-lived, 2h by default).
 * - Automatically refreshes before expiry using the stored session_token.
 */
export function useAnonSession(apiBase: string): AnonSession {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function obtainToken() {
    try {
      setError(null);
      const storedSessionToken = localStorage.getItem(SESSION_TOKEN_KEY);

      const body: Record<string, string> = {};
      if (storedSessionToken) body.session_token = storedSessionToken;

      const res = await fetch(`${apiBase}/api/anon/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error_description?: string };
        throw new Error(err.error_description ?? `HTTP ${res.status}`);
      }

      const data = await res.json() as {
        access_token: string;
        session_token?: string;
        expires_in?: number;
      };

      setAccessToken(data.access_token);

      if (data.session_token) {
        localStorage.setItem(SESSION_TOKEN_KEY, data.session_token);
      }

      // Decode sub from the access token and persist it so the login flow
      // can pass it to the merge endpoint even without Auth0 anonymous_session.
      try {
        const payload = JSON.parse(atob(data.access_token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
        if (payload.sub) localStorage.setItem(ANON_SUB_KEY, payload.sub);
      } catch { /* non-blocking */ }

      // Schedule refresh 60s before expiry (default 7200s for web tokens)
      const expiresIn = data.expires_in ?? 7200;
      const refreshIn = Math.max((expiresIn - 60) * 1000, 30_000);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(obtainToken, refreshIn);
    } catch (err: any) {
      console.warn('[anon-session] failed:', err.message);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    obtainToken();
    return () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); };
  }, [apiBase]);

  return { accessToken, loading, error };
}
