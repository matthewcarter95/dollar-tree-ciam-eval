import { CartItem } from '../components/CartDrawer';
import { colors } from '../theme';

const CATEGORIES = [
  { emoji: '🍬', name: 'Candy & Snacks', price: '$1.25', count: '200+ items' },
  { emoji: '🧹', name: 'Cleaning Supplies', price: '$1.25', count: '150+ items' },
  { emoji: '🎉', name: 'Party Supplies', price: '$1.00', count: '300+ items' },
  { emoji: '✏️', name: 'School & Office', price: '$1.00', count: '180+ items' },
  { emoji: '🌸', name: 'Seasonal & Holiday', price: '$1.25', count: '250+ items' },
  { emoji: '🍴', name: 'Kitchen & Dining', price: '$1.25', count: '120+ items' },
  { emoji: '💊', name: 'Health & Beauty', price: '$1.25', count: '200+ items' },
  { emoji: '🐾', name: 'Pet Supplies', price: '$1.00', count: '90+ items' },
];

const FEATURED: Omit<CartItem, 'qty'>[] = [
  { emoji: '🎈', name: 'Balloon Pack (12ct)', price: '$1.00', pointsCost: 100 },
  { emoji: '🧴', name: 'Hand Sanitizer 8oz', price: '$1.25', pointsCost: 125 },
  { emoji: '🍫', name: 'Chocolate Mix Bag', price: '$1.25', pointsCost: 125 },
  { emoji: '📓', name: 'Spiral Notebook', price: '$1.00', pointsCost: 100 },
  { emoji: '🕯️', name: 'Taper Candles (4ct)', price: '$1.25', pointsCost: 125 },
  { emoji: '🧺', name: 'Mesh Storage Basket', price: '$1.25', pointsCost: 125 },
];

interface StorePageProps {
  onAddToCart: (item: Omit<CartItem, 'qty'>) => void;
}

export default function StorePage({ onAddToCart }: StorePageProps) {
  return (
    <div style={{ background: colors.gray[100], minHeight: '100%' }}>
      {/* Hero */}
      <div style={styles.hero}>
        <h2 style={styles.heroHeading}>Everything at Unbeatable Prices</h2>
        <p style={styles.heroSub}>Thousands of items — most just $1.00 or $1.25</p>
        <div style={styles.heroBadge}>🛒 Free in-store pickup available</div>
      </div>

      {/* Featured Items */}
      <section style={styles.section}>
        <h3 style={styles.sectionTitle}>Featured Items</h3>
        <div style={styles.featuredGrid}>
          {FEATURED.map((item) => (
            <div key={item.name} style={styles.featuredCard}>
              <div style={styles.featuredEmoji}>{item.emoji}</div>
              <p style={styles.featuredName}>{item.name}</p>
              <p style={styles.featuredPrice}>{item.price}</p>
              <button
                style={styles.addButton}
                onClick={() => onAddToCart(item)}
              >
                Add to Cart
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Categories */}
      <section style={styles.section}>
        <h3 style={styles.sectionTitle}>Shop by Category</h3>
        <div style={styles.categoryGrid}>
          {CATEGORIES.map((cat) => (
            <button key={cat.name} style={styles.categoryCard}>
              <span style={styles.categoryEmoji}>{cat.emoji}</span>
              <span style={styles.categoryName}>{cat.name}</span>
              <span style={styles.categoryCount}>{cat.count}</span>
              <span style={styles.categoryPrice}>From {cat.price}</span>
            </button>
          ))}
        </div>
      </section>

      {/* Banner */}
      <div style={styles.banner}>
        <span style={styles.bannerText}>💛 New arrivals every week — check back often!</span>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  hero: {
    background: `linear-gradient(135deg, ${colors.green.primary} 0%, ${colors.green.dark} 100%)`,
    color: colors.white,
    padding: '2.5rem 1.5rem',
    textAlign: 'center',
  },
  heroHeading: {
    fontSize: '1.9rem',
    fontWeight: 800,
    marginBottom: '0.5rem',
    letterSpacing: '-0.5px',
  },
  heroSub: {
    fontSize: '1rem',
    opacity: 0.88,
    marginBottom: '1rem',
  },
  heroBadge: {
    display: 'inline-block',
    background: colors.yellow.primary,
    color: colors.text.onYellow,
    padding: '0.35rem 1rem',
    borderRadius: 20,
    fontSize: '0.85rem',
    fontWeight: 700,
  },
  section: {
    padding: '1.5rem',
    maxWidth: 960,
    margin: '0 auto',
  },
  sectionTitle: {
    fontSize: '1.15rem',
    fontWeight: 700,
    color: colors.green.primary,
    marginBottom: '1rem',
    borderLeft: `4px solid ${colors.yellow.primary}`,
    paddingLeft: '0.6rem',
  },
  featuredGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
    gap: 12,
  },
  featuredCard: {
    background: colors.white,
    borderRadius: 10,
    padding: '1rem 0.75rem',
    textAlign: 'center',
    border: `1px solid ${colors.gray[200]}`,
    boxShadow: '0 1px 4px rgba(0,0,0,.06)',
  },
  featuredEmoji: { fontSize: '2.2rem', marginBottom: 6 },
  featuredName: {
    fontSize: '0.8rem',
    color: colors.text.primary,
    marginBottom: 4,
    fontWeight: 600,
    lineHeight: 1.3,
  },
  featuredPrice: {
    fontSize: '1rem',
    fontWeight: 800,
    color: colors.green.primary,
    marginBottom: 10,
  },
  addButton: {
    width: '100%',
    background: colors.green.primary,
    color: colors.white,
    border: 'none',
    borderRadius: 6,
    padding: '0.4rem 0',
    fontSize: '0.78rem',
    fontWeight: 700,
    cursor: 'pointer',
  },
  categoryGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap: 12,
  },
  categoryCard: {
    background: colors.white,
    border: `1px solid ${colors.gray[200]}`,
    borderRadius: 10,
    padding: '1.1rem 0.75rem',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    cursor: 'pointer',
    textAlign: 'center',
    transition: 'border-color 0.15s',
  },
  categoryEmoji: { fontSize: '2rem' },
  categoryName: {
    fontSize: '0.82rem',
    fontWeight: 700,
    color: colors.text.primary,
    lineHeight: 1.3,
  },
  categoryCount: {
    fontSize: '0.72rem',
    color: colors.text.secondary,
  },
  categoryPrice: {
    fontSize: '0.78rem',
    fontWeight: 700,
    color: colors.green.primary,
  },
  banner: {
    background: colors.yellow.primary,
    textAlign: 'center',
    padding: '0.9rem',
    marginTop: '1rem',
  },
  bannerText: {
    fontSize: '0.9rem',
    fontWeight: 700,
    color: colors.text.onYellow,
  },
};
