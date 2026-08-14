import { useEffect, useRef, useState } from 'react';
import MessageBubble from './MessageBubble';
import { colors } from '../theme';
import { Message, User } from '../types';

interface CibaState {
  auth_req_id: string;
  itemName: string;
  pointsCost: number;
  interval: number; // seconds — from bc-authorize response, minimum poll cadence
}

interface PollResult {
  status: 'pending' | 'slow_down' | 'approved' | 'denied' | 'expired' | 'error';
  newBalance?: number;
  pointsDeducted?: number;
  itemName?: string;
}

interface Props {
  user: User;
  apiBase: string;
}

export default function ChatInterface({ user, apiBase }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [cibaState, setCibaState] = useState<CibaState | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, cibaState]);

  // Poll /api/purchase/poll while a CIBA approval is pending.
  // Uses the interval from bc-authorize (minimum Auth0 polling cadence).
  // Backs off an extra 5 s on slow_down as required by the CIBA spec.
  useEffect(() => {
    if (!cibaState) return;
    let ms = Math.max(cibaState.interval, 5) * 1000; // never faster than 5 s
    let timer: ReturnType<typeof setTimeout>;

    const schedule = () => { timer = setTimeout(poll, ms); };

    const poll = async () => {
      try {
        const r = await fetch(`${apiBase}/api/purchase/poll`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            auth_req_id: cibaState.auth_req_id,
            itemName: cibaState.itemName,
            pointsCost: cibaState.pointsCost,
          }),
        });
        const d = await r.json() as PollResult;

        if (d.status === 'approved') {
          setCibaState(null);
          setMessages((prev) => [...prev, {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `Purchase approved! ${d.itemName ?? cibaState.itemName} purchased for ${d.pointsDeducted ?? cibaState.pointsCost} points. New balance: ${d.newBalance ?? '?'} points.`,
            timestamp: new Date().toISOString(),
          }]);
          return; // stop polling
        }
        if (d.status === 'denied') {
          setCibaState(null);
          setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: 'Purchase declined on your Guardian app.', timestamp: new Date().toISOString() }]);
          return;
        }
        if (d.status === 'expired') {
          setCibaState(null);
          setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: 'Approval request expired. Please try again.', timestamp: new Date().toISOString() }]);
          return;
        }
        if (d.status === 'slow_down') {
          ms += 5000; // CIBA spec: increase interval by 5 s on slow_down
        }
        schedule(); // 'pending' or 'slow_down' → keep polling
      } catch {
        schedule(); // network error — retry at current interval
      }
    };

    schedule();
    return () => clearTimeout(timer);
  }, [cibaState, apiBase]);

  function handleCibaCancel() {
    setCibaState(null);
    setMessages((prev) => [...prev, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'Purchase cancelled.',
      timestamp: new Date().toISOString(),
    }]);
  }

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);

    const optimistic: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);

    try {
      const res = await fetch(`${apiBase}/api/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, conversationId }),
      });

      if (res.status === 401) {
        window.location.href = `${apiBase}/auth/login`;
        return;
      }

      const data = (await res.json()) as { conversationId: string; message: Message; cibaState?: CibaState };
      setConversationId(data.conversationId);
      setMessages((prev) => [...prev, data.message]);
      if (data.cibaState) setCibaState(data.cibaState);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: 'Sorry, something went wrong. Please try again.',
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.chatHeader}>
        <div style={styles.chatHeaderLeft}>
          <span style={styles.botIcon}>🤖</span>
          <div>
            <p style={styles.chatTitle}>DT AI Assistant</p>
            <p style={styles.chatSubtitle}>Ask about products, deals, or anything else</p>
          </div>
        </div>
        {user.picture && (
          <img src={user.picture} alt="" style={styles.userAvatar} referrerPolicy="no-referrer" />
        )}
      </div>

      <div style={styles.messages}>
        {messages.length === 0 && (
          <div style={styles.emptyState}>
            <p style={styles.emptyIcon}>💬</p>
            <p style={styles.emptyTitle}>Hi, {user.name?.split(' ')[0]}!</p>
            <p style={styles.emptySub}>
              Ask me about products, find deals, or get help with your order.
            </p>
            <div style={styles.suggestions}>
              {["What's on sale today?", "Find snacks under $1.25", "Party supply ideas"].map((s) => (
                <button key={s} style={styles.suggestionBtn} onClick={() => { setInput(s); }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {sending && (
          <div style={{ display: 'flex', marginBottom: 12 }}>
            <div style={styles.thinkingBubble}>
              <span style={styles.thinkingDots}>●●●</span>
            </div>
          </div>
        )}
        {cibaState && (
          <div style={styles.cibaCard}>
            <div style={styles.cibaTop}>
              <span style={styles.cibaIcon}>🔐</span>
              <div>
                <p style={styles.cibaTitle}>Guardian Approval Required</p>
                <p style={styles.cibaDesc}>
                  Approve <strong>{cibaState.itemName}</strong> ({cibaState.pointsCost} pts) on your phone
                </p>
              </div>
            </div>
            <div style={styles.cibaBottom}>
              <span style={styles.cibaSpinner}>●●●</span>
              <button style={styles.cibaCancelBtn} onClick={handleCibaCancel}>
                Cancel
              </button>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={styles.footer}>
        <textarea
          style={styles.textarea}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={cibaState ? 'Waiting for Guardian approval…' : 'Ask about products or deals…'}
          rows={1}
          disabled={sending || !!cibaState}
        />
        <button
          style={{
            ...styles.sendButton,
            opacity: sending || !input.trim() || !!cibaState ? 0.5 : 1,
            cursor: sending || !input.trim() || !!cibaState ? 'not-allowed' : 'pointer',
          }}
          onClick={send}
          disabled={sending || !input.trim() || !!cibaState}
        >
          ↑
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    maxWidth: 760,
    margin: '1.5rem auto',
    width: '100%',
    background: colors.white,
    borderRadius: 12,
    boxShadow: '0 2px 16px rgba(0,0,0,.1)',
    overflow: 'hidden',
    height: 'calc(100vh - 120px)',
  },
  chatHeader: {
    background: colors.green.primary,
    color: colors.white,
    padding: '0.9rem 1.25rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  chatHeaderLeft: { display: 'flex', alignItems: 'center', gap: 10 },
  botIcon: { fontSize: '1.5rem' },
  chatTitle: { fontWeight: 700, fontSize: '0.95rem' },
  chatSubtitle: { fontSize: '0.75rem', opacity: 0.8, marginTop: 1 },
  userAvatar: {
    width: 32,
    height: 32,
    borderRadius: '50%',
    border: `2px solid ${colors.yellow.primary}`,
    objectFit: 'cover',
  },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '1.25rem',
    background: colors.gray[50],
  },
  emptyState: {
    textAlign: 'center',
    paddingTop: '3rem',
  },
  emptyIcon: { fontSize: '2.5rem', marginBottom: '0.5rem' },
  emptyTitle: {
    fontSize: '1.2rem',
    fontWeight: 700,
    color: colors.text.primary,
    marginBottom: '0.4rem',
  },
  emptySub: {
    color: colors.text.secondary,
    fontSize: '0.9rem',
    marginBottom: '1.25rem',
  },
  suggestions: {
    display: 'flex',
    gap: 8,
    justifyContent: 'center',
    flexWrap: 'wrap',
  },
  suggestionBtn: {
    background: colors.green.light,
    border: `1px solid ${colors.green.primary}`,
    color: colors.green.dark,
    padding: '0.45rem 0.9rem',
    borderRadius: 20,
    fontSize: '0.82rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  cibaCard: {
    background: colors.white,
    border: `2px solid ${colors.green.primary}`,
    borderRadius: 12,
    padding: '1rem 1.25rem',
    marginBottom: 12,
    boxShadow: '0 2px 12px rgba(0,0,0,.08)',
  },
  cibaTop: { display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 10 },
  cibaIcon: { fontSize: '1.5rem', flexShrink: 0 },
  cibaTitle: { fontWeight: 700, fontSize: '0.9rem', color: colors.text.primary },
  cibaDesc: { fontSize: '0.82rem', color: colors.text.secondary, marginTop: 2 },
  cibaBottom: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  cibaSpinner: {
    color: colors.green.primary,
    letterSpacing: 3,
    fontSize: '0.7rem',
    animation: 'pulse 1s infinite',
  },
  cibaCancelBtn: {
    background: 'transparent',
    border: `1px solid #e53e3e`,
    color: '#e53e3e',
    borderRadius: 6,
    padding: '0.3rem 0.85rem',
    fontSize: '0.8rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  thinkingBubble: {
    background: colors.white,
    border: `1px solid ${colors.gray[200]}`,
    borderRadius: '16px 16px 16px 4px',
    padding: '0.6rem 1rem',
  },
  thinkingDots: {
    color: colors.green.primary,
    letterSpacing: 3,
    fontSize: '0.7rem',
    animation: 'pulse 1s infinite',
  },
  footer: {
    display: 'flex',
    gap: 10,
    padding: '0.9rem 1.25rem',
    borderTop: `1px solid ${colors.gray[200]}`,
    background: colors.white,
    alignItems: 'flex-end',
  },
  textarea: {
    flex: 1,
    resize: 'none',
    border: `1px solid ${colors.gray[400]}`,
    borderRadius: 8,
    padding: '0.6rem 0.9rem',
    fontSize: '0.95rem',
    fontFamily: 'inherit',
    outline: 'none',
    lineHeight: 1.5,
    maxHeight: 120,
  },
  sendButton: {
    background: colors.green.primary,
    color: colors.white,
    border: 'none',
    borderRadius: 8,
    width: 40,
    height: 40,
    fontSize: '1.2rem',
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
};
