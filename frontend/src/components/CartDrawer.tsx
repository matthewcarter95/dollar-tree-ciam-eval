import { colors } from '../theme';

export interface CartItem {
  name: string;
  emoji: string;
  price: string;
  pointsCost: number;
  qty: number;
}

interface CartDrawerProps {
  items: CartItem[];
  open: boolean;
  onClose: () => void;
  onRemove: (name: string) => void;
  onClear: () => void;
}

export default function CartDrawer({ items, open, onClose, onRemove, onClear }: CartDrawerProps) {
  const total = items.reduce((sum, item) => {
    const dollars = parseFloat(item.price.replace('$', ''));
    return sum + dollars * item.qty;
  }, 0);

  const totalPoints = items.reduce((sum, item) => sum + item.pointsCost * item.qty, 0);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div style={styles.backdrop} onClick={onClose} />

      {/* Drawer */}
      <div style={styles.drawer}>
        <div style={styles.header}>
          <h2 style={styles.title}>🛒 Your Cart</h2>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        {items.length === 0 ? (
          <div style={styles.empty}>
            <div style={styles.emptyIcon}>🛒</div>
            <p style={styles.emptyText}>Your cart is empty</p>
            <p style={styles.emptySub}>Add items from the store to get started</p>
          </div>
        ) : (
          <>
            <div style={styles.itemList}>
              {items.map(item => (
                <div key={item.name} style={styles.item}>
                  <span style={styles.itemEmoji}>{item.emoji}</span>
                  <div style={styles.itemInfo}>
                    <p style={styles.itemName}>{item.name}</p>
                    <p style={styles.itemPrice}>{item.price} · {item.pointsCost} pts</p>
                  </div>
                  <div style={styles.itemQty}>
                    <button style={styles.qtyBtn} onClick={() => onRemove(item.name)}>−</button>
                    <span style={styles.qtyNum}>{item.qty}</span>
                  </div>
                </div>
              ))}
            </div>

            <div style={styles.footer}>
              <div style={styles.totals}>
                <div style={styles.totalRow}>
                  <span>Subtotal</span>
                  <span style={styles.totalAmt}>${total.toFixed(2)}</span>
                </div>
                <div style={styles.totalRow}>
                  <span style={styles.ptsLabel}>Points value</span>
                  <span style={styles.ptsAmt}>{totalPoints.toLocaleString()} pts</span>
                </div>
              </div>
              <button style={styles.checkoutBtn}>Proceed to Checkout</button>
              <button style={styles.clearBtn} onClick={onClear}>Clear cart</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.4)',
    zIndex: 200,
  },
  drawer: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    width: 360,
    maxWidth: '95vw',
    background: colors.white,
    zIndex: 201,
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '-4px 0 24px rgba(0,0,0,.18)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '1rem 1.25rem',
    borderBottom: `1px solid ${colors.gray[200]}`,
    background: colors.green.primary,
  },
  title: {
    color: colors.white,
    fontSize: '1.1rem',
    fontWeight: 800,
    margin: 0,
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: colors.white,
    fontSize: '1.2rem',
    cursor: 'pointer',
    padding: '0.25rem',
    lineHeight: 1,
  },
  empty: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2rem',
    gap: 8,
  },
  emptyIcon: { fontSize: '3rem', opacity: 0.35 },
  emptyText: {
    fontSize: '1rem',
    fontWeight: 700,
    color: colors.text.primary,
    margin: 0,
  },
  emptySub: {
    fontSize: '0.85rem',
    color: colors.text.secondary,
    margin: 0,
    textAlign: 'center',
  },
  itemList: {
    flex: 1,
    overflowY: 'auto',
    padding: '0.75rem 1.25rem',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '0.6rem 0',
    borderBottom: `1px solid ${colors.gray[100]}`,
  },
  itemEmoji: { fontSize: '1.6rem', flexShrink: 0 },
  itemInfo: { flex: 1, minWidth: 0 },
  itemName: {
    fontSize: '0.85rem',
    fontWeight: 600,
    color: colors.text.primary,
    margin: '0 0 2px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  itemPrice: {
    fontSize: '0.78rem',
    color: colors.text.secondary,
    margin: 0,
  },
  itemQty: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  qtyBtn: {
    width: 26,
    height: 26,
    borderRadius: '50%',
    border: `1px solid ${colors.gray[400]}`,
    background: colors.white,
    fontSize: '1rem',
    lineHeight: 1,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyNum: {
    fontSize: '0.9rem',
    fontWeight: 700,
    minWidth: 18,
    textAlign: 'center',
  },
  footer: {
    padding: '1rem 1.25rem 1.5rem',
    borderTop: `1px solid ${colors.gray[200]}`,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  totals: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    marginBottom: 4,
  },
  totalRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '0.88rem',
    color: colors.text.primary,
  },
  totalAmt: {
    fontWeight: 800,
    color: colors.green.primary,
    fontSize: '1rem',
  },
  ptsLabel: { color: colors.text.secondary, fontSize: '0.82rem' },
  ptsAmt: {
    fontWeight: 700,
    color: colors.yellow.primary,
    fontSize: '0.88rem',
  },
  checkoutBtn: {
    width: '100%',
    background: colors.green.primary,
    color: colors.white,
    border: 'none',
    borderRadius: 8,
    padding: '0.75rem',
    fontSize: '0.95rem',
    fontWeight: 700,
    cursor: 'pointer',
  },
  clearBtn: {
    width: '100%',
    background: 'transparent',
    color: colors.text.secondary,
    border: `1px solid ${colors.gray[200]}`,
    borderRadius: 8,
    padding: '0.5rem',
    fontSize: '0.82rem',
    cursor: 'pointer',
  },
};
