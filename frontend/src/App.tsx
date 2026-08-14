import { useEffect, useRef, useState } from 'react';
import StorePage from './pages/StorePage';
import ChatInterface from './components/ChatInterface';
import ProfilePage from './pages/ProfilePage';
import { colors } from './theme';
import { User } from './types';

const API_BASE = import.meta.env.VITE_API_BASE || '';

type Tab = 'shop' | 'chat' | 'profile';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('shop');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    checkAuth();
    // Poll every 30s to detect backchannel logout session revocation
    pollRef.current = setInterval(checkAuth, 30_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  async function checkAuth() {
    try {
      const res = await fetch(`${API_BASE}/api/user`, { credentials: 'include' });
      if (res.ok) {
        setUser(await res.json() as User);
      } else {
        if (user !== null) {
          // Session was revoked externally — redirect to login
          window.location.href = `${API_BASE}/auth/login`;
        }
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setAuthChecked(true);
    }
  }

  function handleChatTabClick() {
    if (!user) {
      window.location.href = `${API_BASE}/auth/login`;
    } else {
      setActiveTab('chat');
    }
  }

  return (
    <div style={styles.root}>
      {/* Header */}
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
            {authChecked && (
              user ? (
                <div style={styles.userArea}>
                  {user.picture && (
                    <img src={user.picture} alt="" style={styles.avatar} referrerPolicy="no-referrer" />
                  )}
                  <a href={`${API_BASE}/auth/logout`} style={styles.signOutLink}>Sign out</a>
                </div>
              ) : (
                <a href={`${API_BASE}/auth/login`} style={styles.signInBtn}>Sign In</a>
              )
            )}
          </div>
        </div>
      </header>

      {/* Content */}
      <main style={styles.main}>
        {activeTab === 'shop' && <StorePage />}
        {activeTab === 'chat' && user && (
          <ChatInterface user={user} apiBase={API_BASE} />
        )}
        {activeTab === 'profile' && user && (
          <ProfilePage user={user} apiBase={API_BASE} />
        )}
      </main>
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
    minWidth: 100,
    display: 'flex',
    justifyContent: 'flex-end',
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
  signInBtn: {
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
