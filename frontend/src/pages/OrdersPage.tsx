import { useEffect, useState } from 'react';
import { colors } from '../theme';
import { OrderSummary, OrderDetail } from '../types';

interface Props {
  apiBase: string;
  orderId: string | null;
  onSelect: (id: string | null) => void;
}

const money = (cents: number | null, currency = 'USD') =>
  cents === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
const label = (s: string) => s.replace(/_/g, ' ');

export default function OrdersPage({ apiBase, orderId, onSelect }: Props) {
  return (
    <div style={styles.container}>
      {orderId
        ? <OrderDetailView apiBase={apiBase} orderId={orderId} onBack={() => onSelect(null)} />
        : <OrderList apiBase={apiBase} onSelect={onSelect} />}
    </div>
  );
}

function OrderList({ apiBase, onSelect }: { apiBase: string; onSelect: (id: string) => void }) {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Fetch everything once and filter client-side so the status dropdown always
  // lists every status the user has, not just the filtered one.
  useEffect(() => {
    fetch(`${apiBase}/api/orders`, { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<OrderSummary[]>) : Promise.reject(new Error(String(r.status)))))
      .then((o) => { setOrders(o); setLoading(false); })
      .catch(() => { setError('Could not load orders.'); setLoading(false); });
  }, [apiBase]);

  const statuses = [...new Set(orders.flatMap((o) => o.statuses))].sort();
  const shown = status ? orders.filter((o) => o.statuses.includes(status)) : orders;

  return (
    <div>
      <div style={styles.headRow}>
        <div>
          <h2 style={styles.title}>My Orders</h2>
          <p style={styles.subtitle}>Orders placed through the shopping assistant and partner agents.</p>
        </div>
        <select style={styles.select} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          {statuses.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
      </div>
      {loading && <p style={styles.muted}>Loading…</p>}
      {error && <p style={{ ...styles.muted, color: '#e53e3e' }}>{error}</p>}
      {!loading && !error && shown.length === 0 && (
        <p style={styles.muted}>{orders.length ? 'No orders match this status.' : 'No orders yet.'}</p>
      )}
      <div style={styles.list}>
        {shown.map((o) => (
          <button key={o.id} style={styles.row} onClick={() => onSelect(o.id)}>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <div style={styles.rowTitle}>{o.items.map((i) => `${i.title} ×${i.quantity}`).join(', ') || 'Order'}</div>
              <div style={styles.rowMeta}>{when(o.createdAt)} · #{o.id.slice(0, 8)}</div>
            </div>
            <StatusBadge status={o.status} />
            <div style={styles.rowTotal}>{money(o.totalCents, o.currency)}</div>
            <span style={styles.chev}>›</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function OrderDetailView({ apiBase, orderId, onBack }: { apiBase: string; orderId: string; onBack: () => void }) {
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`${apiBase}/api/orders/${encodeURIComponent(orderId)}`, { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) { setNotFound(true); return; }
        setOrder(await r.json() as OrderDetail);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [apiBase, orderId]);

  return (
    <div>
      <button style={styles.back} onClick={onBack}>‹ All orders</button>
      {loading && <p style={styles.muted}>Loading…</p>}
      {notFound && <p style={styles.muted}>Order not found, or it belongs to a different account.</p>}
      {order && (
        <>
          <div style={styles.headRow}>
            <div>
              <h2 style={styles.title}>Order #{order.id.slice(0, 8)}</h2>
              <p style={styles.subtitle}>Placed {when(order.createdAt)}</p>
            </div>
            <StatusBadge status={order.status} />
          </div>

          <Card title="Items">
            {order.lineItems.map((l) => (
              <div key={l.id} style={styles.itemRow}>
                <div style={{ flex: 1 }}>
                  <div style={styles.rowTitle}>{l.title}</div>
                  <div style={styles.rowMeta}>
                    {money(l.unitPriceCents, order.currency)} × {l.quantity} · {l.fulfilled} of {l.quantity} fulfilled
                  </div>
                </div>
                <StatusBadge status={l.status} />
                <div style={styles.rowTotal}>
                  {money(l.totals.find((t) => t.type === 'total')?.amountCents ?? l.unitPriceCents * l.quantity, order.currency)}
                </div>
              </div>
            ))}
          </Card>

          <Card title="Totals">
            {order.totals.map((t) => (
              <div key={t.type} style={{ ...styles.kv, fontWeight: t.type === 'total' ? 800 : 400 }}>
                <span style={{ textTransform: 'capitalize' }}>{t.type}</span>
                <span>{money(t.amountCents, order.currency)}</span>
              </div>
            ))}
          </Card>

          <Card title="Shipping">
            {order.fulfillment.expectations.length === 0 && <p style={styles.muted}>No shipping details.</p>}
            {order.fulfillment.expectations.map((e, i) => (
              <div key={e.id ?? i} style={{ marginBottom: 6 }}>
                {e.description && <div style={styles.rowTitle}>{e.description}</div>}
                {e.destination && (
                  <div style={styles.rowMeta}>
                    {e.destination.street_address}, {e.destination.address_locality}, {e.destination.address_region}{' '}
                    {e.destination.postal_code} {e.destination.address_country}
                  </div>
                )}
              </div>
            ))}
          </Card>

          <Card title="Fulfillment events">
            {order.fulfillment.events.length === 0
              ? <p style={styles.muted}>No fulfillment events yet.</p>
              : order.fulfillment.events.map((ev, i) => (
                <div key={i} style={styles.kv}>
                  <span>{ev.description ?? label(String(ev.type ?? 'event'))}</span>
                  <span style={styles.rowMeta}>{ev.occurred_at ? when(String(ev.occurred_at)) : ''}</span>
                </div>
              ))}
          </Card>

          <p style={styles.ids}>
            Order ID {order.id}{order.checkoutId ? ` · Checkout ${order.checkoutId}` : ''}
          </p>
        </>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={styles.card}>
      <h3 style={styles.cardTitle}>{title}</h3>
      {children}
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const done = ['fulfilled', 'delivered', 'completed'].includes(status);
  const bad = ['canceled', 'cancelled', 'failed', 'refunded'].includes(status);
  const bg = done ? colors.green.light : bad ? '#fed7d7' : colors.yellow.primary;
  const fg = done ? colors.green.dark : bad ? '#9b2c2c' : colors.green.dark;
  return <span style={{ ...styles.badge, background: bg, color: fg }}>{label(status)}</span>;
}

const styles: Record<string, React.CSSProperties> = {
  container: { flex: 1, padding: '2rem', maxWidth: 780, margin: '0 auto', width: '100%', boxSizing: 'border-box' },
  headRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 16 },
  title: { fontSize: '1.25rem', fontWeight: 700, color: colors.text.primary, marginBottom: 4 },
  subtitle: { fontSize: '0.87rem', color: colors.text.secondary },
  select: { padding: '0.45rem 0.7rem', borderRadius: 8, border: `1px solid ${colors.gray[400]}`, fontSize: '0.88rem', background: colors.white },
  muted: { color: colors.text.secondary, fontSize: '0.9rem', fontStyle: 'italic' },
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  row: {
    display: 'flex', alignItems: 'center', gap: 14, background: colors.white, borderRadius: 10,
    padding: '0.9rem 1rem', border: `1px solid ${colors.gray[200]}`, cursor: 'pointer', font: 'inherit',
  },
  rowTitle: { fontWeight: 700, fontSize: '0.92rem', color: colors.text.primary },
  rowMeta: { fontSize: '0.78rem', color: colors.text.secondary, marginTop: 2 },
  rowTotal: { fontWeight: 700, fontSize: '0.95rem', color: colors.text.primary, minWidth: 70, textAlign: 'right' },
  chev: { color: colors.text.secondary, fontSize: '1.3rem' },
  badge: { padding: '0.2rem 0.6rem', borderRadius: 999, fontSize: '0.75rem', fontWeight: 700, textTransform: 'capitalize', whiteSpace: 'nowrap' },
  back: { background: 'transparent', border: 'none', color: colors.green.primary, fontWeight: 700, cursor: 'pointer', padding: 0, marginBottom: 12, fontSize: '0.9rem' },
  card: { background: colors.white, borderRadius: 12, padding: '1rem 1.25rem', border: `1px solid ${colors.gray[200]}`, marginBottom: 12 },
  cardTitle: { fontSize: '0.8rem', fontWeight: 700, color: colors.text.secondary, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 },
  itemRow: { display: 'flex', alignItems: 'center', gap: 14, padding: '0.4rem 0' },
  kv: { display: 'flex', justifyContent: 'space-between', padding: '0.25rem 0', fontSize: '0.9rem' },
  ids: { fontSize: '0.72rem', color: colors.text.secondary, fontFamily: 'monospace', wordBreak: 'break-all' },
};
