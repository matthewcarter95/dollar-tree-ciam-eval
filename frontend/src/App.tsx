import { useEffect, useRef, useState } from 'react';
import StorePage from './pages/StorePage';
import ChatInterface from './components/ChatInterface';
import ProfilePage from './pages/ProfilePage';
import CartDrawer, { CartItem } from './components/CartDrawer';
import { useAnonSession, ANON_SUB_KEY } from './hooks/useAnonSession';
import { colors } from './theme';
import { User } from './types';

const API_BASE = import.meta.env.VITE_API_BASE || '';

type Tab = 'shop' | 'chat' | 'profile';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('shop');
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [cartLoading, setCartLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { accessToken: anonToken } = useAnonSession(API_BASE);

  useEffect(() => {
    checkAuth();
    pollRef.current = setInterval(checkAuth, 30_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Load cart whenever auth state or anon token becomes available.
  // Authenticated users: rely on OIDC session cookie (no Bearer token needed) —
  // the backend resolves their sub from the session, returning the merged cart.
  // Anonymous users: use the anon Bearer token.
  // Also clear the stored anonymous session_token when the user has logged in so
  // their next anonymous browsing gets a fresh identity.
  useEffect(() => {
    if (!authChecked) return;

    if (user) {
      // If an anonymous cart was built before login, merge it now.
      // This is the client-side fallback for when the Auth0 Post-Login Action
      // cannot populate event.anonymous_session (e.g. cookie not forwarded).
      const anonSub = localStorage.getItem(ANON_SUB_KEY);
      if (anonSub) {
        fetch(`${API_BASE}/api/cart/merge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ anonSub }),
        }).catch(() => {});
        localStorage.removeItem(ANON_SUB_KEY);
      }

      // Clear any stale anonymous session from localStorage
      localStorage.removeItem('dt_anon_session_token');
      fetch(`${API_BASE}/api/cart`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data?.items) setCartItems(data.items); })
        .catch(() => {});
    } else if (anonToken) {
      fetch(`${API_BASE}/api/cart`, {
        headers: { Authorization: `Bearer ${anonToken}` },
        credentials: 'include',
      })
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data?.items) setCartItems(data.items); })
        .catch(() => {});
    }
  }, [user, authChecked, anonToken]);

  async function checkAuth() {
    try {
      const res = await fetch(`${API_BASE}/api/user`, { credentials: 'include' });
      if (res.ok) {
        setUser(await res.json() as User);
      } else {
        if (user !== null) window.location.href = `${API_BASE}/auth/login`;
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setAuthChecked(true);
    }
  }

  async function handleAddToCart(item: Omit<CartItem, 'qty'>) {
    if (cartLoading) return;
    setCartLoading(true);

    // Optimistic update
    setCartItems(prev => {
      const idx = prev.findIndex(i => i.name === item.name);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = { ...updated[idx], qty: updated[idx].qty + 1 };
        return updated;
      }
      return [...prev, { ...item, qty: 1 }];
    });

    if (user || anonToken) {
      try {
        const headers: HeadersInit = { 'Content-Type': 'application/json' };
        if (!user && anonToken) headers['Authorization'] = `Bearer ${anonToken}`;
        const res = await fetch(`${API_BASE}/api/cart`, {
          method: 'POST',
          headers,
          credentials: 'include',
          body: JSON.stringify(item),
        });
        if (res.ok) {
          const data = await res.json() as { items: CartItem[] };
          setCartItems(data.items);
        }
      } catch (err) {
        console.warn('[cart] add failed:', err);
      }
    }

    setCartLoading(false);
    setCartOpen(true);
  }

  async function handleRemoveFromCart(name: string) {
    // Optimistic update
    setCartItems(prev => {
      const idx = prev.findIndex(i => i.name === name);
      if (idx < 0) return prev;
      if (prev[idx].qty > 1) {
        const updated = [...prev];
        updated[idx] = { ...updated[idx], qty: updated[idx].qty - 1 };
        return updated;
      }
      return prev.filter(i => i.name !== name);
    });

    if (user || anonToken) {
      try {
        const headers: HeadersInit = {};
        if (!user && anonToken) headers['Authorization'] = `Bearer ${anonToken}`;
        await fetch(`${API_BASE}/api/cart/${encodeURIComponent(name)}`, {
          method: 'DELETE',
          headers,
          credentials: 'include',
        });
      } catch (err) {
        console.warn('[cart] remove failed:', err);
      }
    }
  }

  async function handleClearCart() {
    setCartItems([]);
    if (user || anonToken) {
      try {
        const headers: HeadersInit = {};
        if (!user && anonToken) headers['Authorization'] = `Bearer ${anonToken}`;
        await fetch(`${API_BASE}/api/cart`, {
          method: 'DELETE',
          headers,
          credentials: 'include',
        });
      } catch (err) {
        console.warn('[cart] clear failed:', err);
      }
    }
  }

  function loginUrl(path: '/auth/login' | '/auth/signup') {
    const sessionToken = localStorage.getItem('dt_anon_session_token');
    const url = `${API_BASE}${path}`;
    return sessionToken ? `${url}?session_token=${encodeURIComponent(sessionToken)}` : url;
  }

  function handleChatTabClick() {
    if (!user) {
      window.location.href = loginUrl('/auth/login');
    } else {
      setActiveTab('chat');
    }
  }

  const cartCount = cartItems.reduce((s, i) => s + i.qty, 0);

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div style={styles.logo}>
            <span style={styles.logoMark}>DT</span>
            <span style={styles.logoText}>Dollar Treasure</span>
          </div>
          <nav style={styles.nav}>
            <button
              style={{ ...styles.navBtn, ...(activeTab === 'shop' ? styles.navBtnActive : {}) }}
              onClick={() => setActiveTab('shop')}
            >
              🛒 Shop
            </button>
            <button
              style={{ ...styles.navBtn, ...(activeTab === 'chat' ? styles.navBtnActive : {}) }}
              onClick={handleChatTabClick}
            >
              💬 AI Assistant
            </button>
            {user && (
              <button
                style={{ ...styles.navBtn, ...(activeTab === 'profile' ? styles.navBtnActive : {}) }}
                onClick={() => setActiveTab('profile')}
              >
                👤 Profile
              </button>
            )}
          </nav>
          <div style={styles.headerRight}>
            {/* Cart button — visible to all users (anonymous + authenticated) */}
            <button style={styles.cartBtn} onClick={() => setCartOpen(true)}>
              🛒
              {cartCount > 0 && (
                <span style={styles.cartBadge}>{cartCount}</span>
              )}
            </button>

            {authChecked && (
              user ? (
                <div style={styles.userArea}>
                  {user.picture && (
                    <img src={user.picture} alt="" style={styles.avatar} referrerPolicy="no-referrer" />
                  )}
                  <a href={`${API_BASE}/auth/logout`} style={styles.signOutLink}>Sign out</a>
                </div>
              ) : (
                <div style={styles.authButtons}>
                  <a href={loginUrl('/auth/login')} style={styles.signInBtn}>Sign In</a>
                  <a href={loginUrl('/auth/signup')} style={styles.signUpBtn}>Sign Up</a>
                </div>
              )
            )}
          </div>
        </div>
      </header>

      <main style={styles.main}>
        {activeTab === 'shop' && (
          <StorePage onAddToCart={handleAddToCart} />
        )}
        {activeTab === 'chat' && user && (
          <ChatInterface user={user} apiBase={API_BASE} />
        )}
        {activeTab === 'profile' && user && (
          <ProfilePage user={user} apiBase={API_BASE} />
        )}
      </main>

      <CartDrawer
        items={cartItems}
        open={cartOpen}
        onClose={() => setCartOpen(false)}
        onRemove={handleRemoveFromCart}
        onClear={handleClearCart}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100vh',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  header: {
    background: colors.green.primary,
    color: colors.white,
    boxShadow: '0 2px 8px rgba(0,0,0,.15)',
    position: 'sticky',
    top: 0,
    zIndex: 100,
  },
  headerInner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 1.25rem',
    height: 60,
    maxWidth: 1200,
    margin: '0 auto',
    width: '100%',
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  logoMark: {
    background: colors.yellow.primary,
    color: colors.green.dark,
    fontWeight: 900,
    fontSize: '1.1rem',
    padding: '0.25rem 0.55rem',
    borderRadius: 6,
    letterSpacing: '-0.5px',
  },
  logoText: {
    color: colors.white,
    fontWeight: 800,
    fontSize: '1.1rem',
    letterSpacing: '-0.3px',
  },
  nav: {
    display: 'flex',
    gap: 4,
  },
  navBtn: {
    background: 'transparent',
    border: 'none',
    color: 'rgba(255,255,255,0.85)',
    padding: '0.45rem 0.9rem',
    borderRadius: 6,
    fontSize: '0.88rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  navBtnActive: {
    background: colors.green.dark,
    color: colors.white,
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  cartBtn: {
    position: 'relative',
    background: 'rgba(255,255,255,0.15)',
    border: 'none',
    borderRadius: 8,
    padding: '0.35rem 0.7rem',
    fontSize: '1.1rem',
    cursor: 'pointer',
    lineHeight: 1,
  },
  cartBadge: {
    position: 'absolute',
    top: -6,
    right: -6,
    background: colors.yellow.primary,
    color: colors.green.dark,
    fontSize: '0.65rem',
    fontWeight: 900,
    borderRadius: '50%',
    width: 18,
    height: 18,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  userArea: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: '50%',
    border: `2px solid ${colors.yellow.primary}`,
    objectFit: 'cover',
  },
  signOutLink: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: '0.82rem',
    textDecoration: 'none',
  },
  authButtons: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },
  signInBtn: {
    background: 'transparent',
    color: colors.white,
    padding: '0.4rem 1rem',
    borderRadius: 6,
    fontSize: '0.85rem',
    fontWeight: 600,
    textDecoration: 'none',
    border: `1px solid rgba(255,255,255,0.6)`,
  },
  signUpBtn: {
    background: colors.yellow.primary,
    color: colors.green.dark,
    padding: '0.4rem 1rem',
    borderRadius: 6,
    fontSize: '0.85rem',
    fontWeight: 700,
    textDecoration: 'none',
  },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
  },
};
