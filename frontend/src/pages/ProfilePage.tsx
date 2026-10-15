import { useEffect, useState } from 'react';
import { colors } from '../theme';
import { User, UserProfile, Address, PaymentMethod, MfaFactor, LoyaltyData } from '../types';

interface Props {
  user: User;
  apiBase: string;
}

type Section = 'personal' | 'loyalty' | 'security' | 'addresses' | 'payments';

export default function ProfilePage({ user, apiBase }: Props) {
  const [activeSection, setActiveSection] = useState<Section>('personal');

  return (
    <div style={styles.container}>
      {/* Sidebar nav */}
      <aside style={styles.sidebar}>
        <div style={styles.avatarWrap}>
          {user.picture && (
            <img src={user.picture} alt="" style={styles.avatar} referrerPolicy="no-referrer" />
          )}
          <p style={styles.userName}>{user.name}</p>
          <p style={styles.userEmail}>{user.email}</p>
        </div>
        {(['personal', 'loyalty', 'security', 'addresses', 'payments'] as Section[]).map((s) => (
          <button
            key={s}
            style={{ ...styles.navBtn, ...(activeSection === s ? styles.navBtnActive : {}) }}
            onClick={() => setActiveSection(s)}
          >
            {sectionLabel(s)}
          </button>
        ))}
      </aside>

      {/* Content */}
      <main style={styles.content}>
        {activeSection === 'personal' && <PersonalDetails user={user} apiBase={apiBase} />}
        {activeSection === 'loyalty'  && <LoyaltySection  user={user} apiBase={apiBase} />}
        {activeSection === 'security' && <SecuritySection user={user} apiBase={apiBase} />}
        {activeSection === 'addresses' && <AddressBook    user={user} apiBase={apiBase} />}
        {activeSection === 'payments' && <PaymentMethods apiBase={apiBase} />}
      </main>
    </div>
  );
}

function sectionLabel(s: Section) {
  return { personal: '👤 Personal Details', loyalty: '🏅 Loyalty Program', security: '🔐 Security', addresses: '📦 Address Book', payments: '💳 Payment Methods' }[s];
}

// ─── Personal Details ──────────────────────────────────────────────────────────
function PersonalDetails({ user, apiBase }: { user: User; apiBase: string }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    fetch(`${apiBase}/api/profile`, { credentials: 'include' })
      .then((r) => r.json() as Promise<UserProfile>)
      .then((p) => { setProfile(p); setName(p.name ?? ''); setPhone(p.phone ?? ''); });
  }, [apiBase]);

  async function save() {
    setSaving(true); setMsg('');
    const res = await fetch(`${apiBase}/api/profile`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone }),
    });
    setSaving(false);
    setMsg(res.ok ? '✅ Saved!' : '❌ Save failed');
    setTimeout(() => setMsg(''), 3000);
  }

  if (!profile) return <p style={styles.loading}>Loading…</p>;

  return (
    <div>
      <SectionHeader title="Personal Details" subtitle="Update your display name and contact number." />
      <div style={styles.form}>
        <Field label="Name" value={name} onChange={setName} />
        <Field label="Email" value={profile.email} readOnly hint="Managed by Auth0 — contact support to change" />
        <Field label="Phone" value={phone} onChange={setPhone} placeholder="+1 555 000 0000" />
        {profile.loyaltyId && <Field label="Loyalty ID" value={String(profile.loyaltyId)} readOnly />}
        <div style={styles.formFooter}>
          <button style={styles.saveBtn} onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
          {msg && <span style={styles.saveMsg}>{msg}</span>}
        </div>
      </div>
    </div>
  );
}

// ─── Loyalty ───────────────────────────────────────────────────────────────────
function LoyaltySection({ user, apiBase }: { user: User; apiBase: string }) {
  const [data, setData] = useState<LoyaltyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true); setError('');
    const res = await fetch(`${apiBase}/api/loyalty`, { credentials: 'include' });
    if (res.ok) setData(await res.json() as LoyaltyData);
    else setError((await res.json() as { error?: string }).error ?? 'Failed to load');
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  return (
    <div>
      <SectionHeader title="Loyalty Program" subtitle="Track and redeem your DT reward points." />
      {loading && <p style={styles.loading}>Loading…</p>}
      {error && <p style={{ color: 'red' }}>{error}</p>}
      {!loading && !error && (
        <div style={styles.loyaltyCard}>
          <div style={styles.loyaltyPoints}>{(data?.totalPoints ?? 0).toLocaleString()}</div>
          <div style={styles.loyaltyLabel}>points available</div>
          {data?.loyaltyId && (
            <div style={{ marginTop: 8, fontSize: '0.8rem', color: 'rgba(255,255,255,0.75)' }}>
              Loyalty ID: {data.loyaltyId}
            </div>
          )}
          <button style={{ ...styles.saveBtn, marginTop: 16, fontSize: '0.82rem' }} onClick={load}>
            Refresh Balance
          </button>
        </div>
      )}
      <div style={styles.hint}>
        💬 You can also redeem coupon codes directly in the AI Assistant chat.
      </div>
    </div>
  );
}

interface EnrollmentData {
  enrollmentId: string;
  authSession: string;
  secret: string;
  barcodeUri: string;
  qrCodeDataUrl: string;
  recoveryCodes: string[];
}

// ─── Security (MFA) ────────────────────────────────────────────────────────────
function SecuritySection({ apiBase }: { user: User; apiBase: string }) {
  const [factors, setFactors] = useState<MfaFactor[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [enrollment, setEnrollment] = useState<EnrollmentData | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  function loadFactors() {
    setLoading(true);
    return fetch(`${apiBase}/api/profile/mfa`, { credentials: 'include' })
      .then((r) => r.json() as Promise<MfaFactor[]>)
      .then((f) => { setFactors(Array.isArray(f) ? f : []); setLoading(false); })
      .catch(() => setLoading(false));
  }

  useEffect(() => { loadFactors(); }, [apiBase]);

  async function removeFactor(id: string) {
    if (!confirm('Remove this MFA factor?')) return;
    setDeleting(id);
    await fetch(`${apiBase}/api/profile/mfa/${id}`, { method: 'DELETE', credentials: 'include' });
    setFactors((prev) => prev.filter((f) => f.id !== id));
    setDeleting(null);
  }

  async function startEnrollment() {
    setEnrolling(true);
    setEnrollment(null);
    try {
      const res = await fetch(`${apiBase}/api/profile/mfa/enroll`, {
        method: 'POST',
        credentials: 'include',
      });
      const body = await res.json() as { error?: string; code?: string; secret?: string };
      if (!res.ok) {
        if (body.code === 'ENROLL_SCOPE_MISSING') {
          // Re-login required to pick up the enroll scope added to the auth flow
          if (confirm(`${body.error}\n\nSign out now?`)) {
            window.location.href = `${apiBase}/auth/logout`;
          }
          return;
        }
        alert(body.error ?? 'Failed to start enrollment');
        return;
      }
      setEnrollment(body as unknown as EnrollmentData);
    } finally {
      setEnrolling(false);
    }
  }

  async function confirmEnrollment() {
    if (!enrollment) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const res = await fetch(`${apiBase}/api/profile/mfa/confirm`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enrollmentId: enrollment.enrollmentId, authSession: enrollment.authSession }),
      });
      const body = await res.json() as { ok?: boolean; error?: string; code?: string };
      if (!res.ok) {
        setConfirmError(body.error ?? 'Verification failed');
        return;
      }
      setEnrollment(null);
      setOtpCode('');
      loadFactors();
    } finally {
      setConfirming(false);
    }
  }

  function cancelEnrollment() {
    setEnrollment(null);
    setOtpCode('');
    setConfirmError(null);
    loadFactors();
  }

  const factorIcon = (type: string) =>
    ({ totp: '📱', sms: '💬', email: '📧', webauthn: '🔑', push: '🔔' }[type] ?? '🔐');

  return (
    <div>
      <SectionHeader title="Security" subtitle="Manage your multi-factor authentication methods." />
      {loading && <p style={styles.loading}>Loading…</p>}
      {!loading && factors.length === 0 && !enrollment && (
        <p style={styles.emptyState}>No MFA factors enrolled yet.</p>
      )}
      <div style={styles.factorList}>
        {factors.map((f) => (
          <div key={f.id} style={styles.factorRow}>
            <span style={{ fontSize: '1.5rem' }}>{factorIcon(f.type)}</span>
            <div style={{ flex: 1 }}>
              <p style={styles.factorName}>{f.name ?? f.type}</p>
              <p style={styles.factorMeta}>
                {f.type.toUpperCase()} · {f.confirmed ? '✅ Confirmed' : '⚠️ Unconfirmed'}
                {' · Added '}{new Date(f.created_at).toLocaleDateString()}
              </p>
            </div>
            <button style={styles.deleteBtn} onClick={() => removeFactor(f.id)} disabled={deleting === f.id}>
              {deleting === f.id ? '…' : 'Remove'}
            </button>
          </div>
        ))}
      </div>

      {/* Push notification enrollment — shown after clicking Add */}
      {enrollment && (
        <div style={styles.enrollCard}>
          <p style={styles.formTitle}>🔔 Enroll with Auth0 Guardian</p>
          <p style={{ fontSize: '0.82rem', color: colors.text.secondary, marginBottom: 12 }}>
            Scan this QR code in the <strong>Auth0 Guardian</strong> app to register your device for push notifications.
          </p>
          {enrollment.qrCodeDataUrl && (
            <img src={enrollment.qrCodeDataUrl} alt="Guardian enrollment QR" style={styles.qrCode} />
          )}
          {enrollment.secret && (
            <details style={{ marginTop: 12 }}>
              <summary style={{ fontSize: '0.78rem', color: colors.text.secondary, cursor: 'pointer' }}>
                Can't scan? Enter the key manually
              </summary>
              <code style={styles.secretCode}>{enrollment.secret}</code>
            </details>
          )}
          <p style={{ fontSize: '0.82rem', color: colors.text.secondary, marginTop: 14, marginBottom: 8 }}>
            Once you've scanned and approved in Guardian, click below to confirm enrollment.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button style={styles.saveBtn} onClick={confirmEnrollment} disabled={confirming}>
              {confirming ? '⏳ Verifying…' : '✅ I scanned it'}
            </button>
            <button style={styles.cancelBtn} onClick={cancelEnrollment}>Cancel</button>
          </div>
          {confirmError && (
            <p style={{ fontSize: '0.8rem', color: '#c0392b', marginTop: 8 }}>{confirmError}</p>
          )}
        </div>
      )}

      {!enrollment && (
        <div style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
          <button style={styles.addBtn} onClick={startEnrollment} disabled={enrolling}>
            {enrolling ? '…' : '+ Add Push Notification (Guardian)'}
          </button>
          <button style={{ ...styles.cancelBtn, fontSize: '0.8rem' }} onClick={loadFactors}>
            ↻ Refresh
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Address Book ──────────────────────────────────────────────────────────────
const EMPTY_ADDR = { label: '', street: '', city: '', state: '', zip: '', country: 'US' };

function AddressBook({ apiBase }: { user: User; apiBase: string }) {
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_ADDR);
  const [adding, setAdding] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${apiBase}/api/profile/addresses`, { credentials: 'include' })
      .then((r) => r.json() as Promise<Address[]>)
      .then((a) => { setAddresses(Array.isArray(a) ? a : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [apiBase]);

  async function addAddress() {
    if (!form.street || !form.city || !form.state || !form.zip) return;
    setAdding(true);
    const res = await fetch(`${apiBase}/api/profile/addresses`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      const addr = await res.json() as Address;
      setAddresses((prev) => [...prev, addr]);
      setForm(EMPTY_ADDR);
      setShowForm(false);
    }
    setAdding(false);
  }

  async function deleteAddress(id: string) {
    if (!confirm('Remove this address?')) return;
    setDeleting(id);
    await fetch(`${apiBase}/api/profile/addresses/${id}`, { method: 'DELETE', credentials: 'include' });
    setAddresses((prev) => prev.filter((a) => a.id !== id));
    setDeleting(null);
  }

  const set = (k: keyof typeof EMPTY_ADDR) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [k]: e.target.value }));

  return (
    <div>
      <SectionHeader title="Address Book" subtitle="Saved shipping addresses for fast checkout." />
      {loading && <p style={styles.loading}>Loading…</p>}
      <div style={styles.addrList}>
        {addresses.map((a) => (
          <div key={a.id} style={styles.addrCard}>
            <div style={styles.addrLabel}>{a.label || 'Address'}</div>
            <p style={styles.addrLine}>{a.street}</p>
            <p style={styles.addrLine}>{a.city}, {a.state} {a.zip}</p>
            <p style={styles.addrLine}>{a.country}</p>
            <button
              style={{ ...styles.deleteBtn, marginTop: 8 }}
              onClick={() => deleteAddress(a.id)}
              disabled={deleting === a.id}
            >
              {deleting === a.id ? '…' : 'Remove'}
            </button>
          </div>
        ))}
        {!loading && addresses.length === 0 && (
          <p style={styles.emptyState}>No saved addresses yet.</p>
        )}
      </div>

      {!showForm && (
        <button style={styles.addBtn} onClick={() => setShowForm(true)}>+ Add Address</button>
      )}

      {showForm && (
        <div style={styles.addrForm}>
          <p style={styles.formTitle}>New Address</p>
          <div style={styles.formGrid}>
            <Field label="Label (e.g. Home)" value={form.label} onChange={(v) => setForm((p) => ({ ...p, label: v }))} placeholder="Home" />
            <Field label="Street *" value={form.street} onChange={(v) => setForm((p) => ({ ...p, street: v }))} placeholder="123 Main St" />
            <Field label="City *" value={form.city} onChange={(v) => setForm((p) => ({ ...p, city: v }))} />
            <Field label="State *" value={form.state} onChange={(v) => setForm((p) => ({ ...p, state: v.toUpperCase() }))} placeholder="OR" maxLength={2} />
            <Field label="ZIP *" value={form.zip} onChange={(v) => setForm((p) => ({ ...p, zip: v }))} />
            <Field label="Country *" value={form.country} onChange={(v) => setForm((p) => ({ ...p, country: v }))} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button style={styles.saveBtn} onClick={addAddress} disabled={adding}>{adding ? 'Saving…' : 'Save Address'}</button>
            <button style={styles.cancelBtn} onClick={() => { setShowForm(false); setForm(EMPTY_ADDR); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Payment Methods (mock) ────────────────────────────────────────────────────
const EMPTY_CARD = { name: '', number: '', expMonth: '', expYear: '', cvv: '' };

function PaymentMethods({ apiBase }: { apiBase: string }) {
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_CARD);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`${apiBase}/api/profile/payment-methods`, { credentials: 'include' })
      .then((r) => r.json() as Promise<PaymentMethod[]>)
      .then((m) => { setMethods(Array.isArray(m) ? m : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [apiBase]);

  async function addCard() {
    setError('');
    setSaving(true);
    const res = await fetch(`${apiBase}/api/profile/payment-methods`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      const m = await res.json() as PaymentMethod;
      setMethods((prev) => [...prev, m]);
      setForm(EMPTY_CARD);
      setShowForm(false);
    } else {
      const d = await res.json().catch(() => ({})) as { error?: string };
      setError(d.error ?? 'Failed to add card');
    }
    setSaving(false);
  }

  async function removeCard(id: string) {
    if (!confirm('Remove this payment method?')) return;
    setDeleting(id);
    const res = await fetch(`${apiBase}/api/profile/payment-methods/${id}`, { method: 'DELETE', credentials: 'include' });
    if (res.ok) {
      setMethods((prev) => {
        const next = prev.filter((m) => m.id !== id);
        if (next.length && !next.some((m) => m.isDefault)) next[0] = { ...next[0], isDefault: true };
        return next;
      });
    }
    setDeleting(null);
  }

  const set = (k: keyof typeof EMPTY_CARD, digitsOnly = false) => (v: string) =>
    setForm((p) => ({ ...p, [k]: digitsOnly ? v.replace(/\D/g, '') : v }));

  return (
    <div>
      <SectionHeader title="Payment Methods" subtitle="Demo only: use test card numbers, never a real card. The number is stored (not the CVV) so it can be replayed to UCP." />
      {loading && <p style={styles.loading}>Loading…</p>}
      <div style={styles.addrList}>
        {methods.map((m) => (
          <div key={m.id} style={styles.addrCard}>
            <div style={styles.addrLabel}>{m.brand}{m.isDefault ? ' (default)' : ''}</div>
            <p style={styles.addrLine}>•••• •••• •••• {m.last4}</p>
            <p style={styles.addrLine}>{m.name}</p>
            <p style={styles.addrLine}>Exp {String(m.expMonth).padStart(2, '0')}/{m.expYear}</p>
            <button style={{ ...styles.deleteBtn, marginTop: 8 }} onClick={() => removeCard(m.id)} disabled={deleting === m.id}>
              {deleting === m.id ? '…' : 'Remove'}
            </button>
          </div>
        ))}
        {!loading && methods.length === 0 && <p style={styles.emptyState}>No saved payment methods yet.</p>}
      </div>

      {!showForm && <button style={styles.addBtn} onClick={() => setShowForm(true)}>+ Add Card</button>}

      {showForm && (
        <div style={styles.addrForm}>
          <p style={styles.formTitle}>New Card</p>
          <div style={styles.formGrid}>
            <Field label="Name on card *" value={form.name} onChange={set('name')} placeholder="Jane Doe" />
            <Field label="Card number *" value={form.number} onChange={set('number', true)} placeholder="4242424242424242" maxLength={19} />
            <Field label="Exp month *" value={form.expMonth} onChange={set('expMonth', true)} placeholder="MM" maxLength={2} />
            <Field label="Exp year *" value={form.expYear} onChange={set('expYear', true)} placeholder="YYYY" maxLength={4} />
            <Field label="CVV *" value={form.cvv} onChange={set('cvv', true)} placeholder="123" maxLength={4} type="password" />
          </div>
          {error && <p style={{ ...styles.saveMsg, color: '#e53e3e', marginTop: 8 }}>{error}</p>}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button style={styles.saveBtn} onClick={addCard} disabled={saving}>{saving ? 'Saving…' : 'Save Card'}</button>
            <button style={styles.cancelBtn} onClick={() => { setShowForm(false); setForm(EMPTY_CARD); setError(''); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Shared sub-components ─────────────────────────────────────────────────────
function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={styles.sectionHeader}>
      <h2 style={styles.sectionTitle}>{title}</h2>
      <p style={styles.sectionSubtitle}>{subtitle}</p>
      <hr style={styles.divider} />
    </div>
  );
}

function Field({
  label, value, onChange, readOnly, hint, placeholder, maxLength, type,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  hint?: string;
  placeholder?: string;
  maxLength?: number;
  type?: string;
}) {
  return (
    <div style={styles.field}>
      <label style={styles.fieldLabel}>{label}</label>
      <input
        style={{ ...styles.fieldInput, ...(readOnly ? styles.fieldReadOnly : {}) }}
        value={value}
        readOnly={readOnly}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        placeholder={placeholder}
        maxLength={maxLength}
        type={type}
      />
      {hint && <p style={styles.fieldHint}>{hint}</p>}
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flex: 1, minHeight: 'calc(100vh - 60px)', background: colors.gray[100] },
  sidebar: {
    width: 220, background: colors.white,
    borderRight: `1px solid ${colors.gray[200]}`,
    padding: '1.5rem 0.75rem',
    display: 'flex', flexDirection: 'column', gap: 4,
  },
  avatarWrap: { textAlign: 'center', marginBottom: '1.25rem', padding: '0 0.5rem' },
  avatar: { width: 64, height: 64, borderRadius: '50%', border: `3px solid ${colors.green.primary}`, objectFit: 'cover' },
  userName: { fontWeight: 700, fontSize: '0.9rem', marginTop: 8, color: colors.text.primary },
  userEmail: { fontSize: '0.75rem', color: colors.text.secondary, marginTop: 2, wordBreak: 'break-all' },
  navBtn: {
    background: 'transparent', border: 'none', textAlign: 'left',
    padding: '0.6rem 0.75rem', borderRadius: 8, cursor: 'pointer',
    fontSize: '0.85rem', color: colors.text.secondary, fontWeight: 500,
  },
  navBtnActive: { background: colors.green.light, color: colors.green.dark, fontWeight: 700 },
  content: { flex: 1, padding: '2rem', maxWidth: 680 },
  sectionHeader: { marginBottom: '1.5rem' },
  sectionTitle: { fontSize: '1.25rem', fontWeight: 700, color: colors.text.primary, marginBottom: 4 },
  sectionSubtitle: { fontSize: '0.87rem', color: colors.text.secondary },
  divider: { border: 'none', borderTop: `1px solid ${colors.gray[200]}`, marginTop: 12 },
  form: { display: 'flex', flexDirection: 'column', gap: 16 },
  formGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  formTitle: { fontWeight: 700, color: colors.text.primary, marginBottom: 8 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  fieldLabel: { fontSize: '0.8rem', fontWeight: 600, color: colors.text.secondary, textTransform: 'uppercase', letterSpacing: '0.03em' },
  fieldInput: {
    padding: '0.55rem 0.8rem', borderRadius: 8, fontSize: '0.92rem',
    border: `1px solid ${colors.gray[400]}`, outline: 'none', fontFamily: 'inherit',
  },
  fieldReadOnly: { background: colors.gray[100], color: colors.text.secondary, cursor: 'default' },
  fieldHint: { fontSize: '0.73rem', color: colors.text.secondary, fontStyle: 'italic' },
  formFooter: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 },
  saveBtn: {
    background: colors.green.primary, color: colors.white, border: 'none',
    borderRadius: 8, padding: '0.55rem 1.25rem', fontWeight: 700,
    fontSize: '0.9rem', cursor: 'pointer',
  },
  cancelBtn: {
    background: colors.gray[200], color: colors.text.primary, border: 'none',
    borderRadius: 8, padding: '0.55rem 1rem', fontWeight: 600, cursor: 'pointer',
  },
  addBtn: {
    background: 'transparent', color: colors.green.primary,
    border: `2px dashed ${colors.green.primary}`, borderRadius: 8,
    padding: '0.55rem 1.25rem', fontWeight: 700, cursor: 'pointer',
    marginTop: 12, fontSize: '0.9rem',
  },
  saveMsg: { fontSize: '0.85rem', fontWeight: 600 },
  loading: { color: colors.text.secondary, fontSize: '0.9rem' },
  emptyState: { color: colors.text.secondary, fontSize: '0.9rem', fontStyle: 'italic' },
  hint: { marginTop: 16, fontSize: '0.82rem', color: colors.text.secondary, background: colors.green.light, padding: '0.6rem 0.9rem', borderRadius: 8 },
  // Loyalty
  loyaltyCard: {
    background: `linear-gradient(135deg, ${colors.green.primary}, ${colors.green.dark})`,
    color: colors.white, borderRadius: 16, padding: '2rem',
    textAlign: 'center', maxWidth: 300,
  },
  loyaltyPoints: { fontSize: '3rem', fontWeight: 900, lineHeight: 1 },
  loyaltyLabel: { fontSize: '0.85rem', opacity: 0.85, marginTop: 4 },
  // MFA
  factorList: { display: 'flex', flexDirection: 'column', gap: 8 },
  factorRow: {
    display: 'flex', alignItems: 'center', gap: 14,
    background: colors.white, borderRadius: 10,
    padding: '0.85rem 1rem', border: `1px solid ${colors.gray[200]}`,
  },
  factorName: { fontWeight: 700, fontSize: '0.9rem', color: colors.text.primary },
  factorMeta: { fontSize: '0.75rem', color: colors.text.secondary, marginTop: 2 },
  deleteBtn: {
    background: 'transparent', border: `1px solid #e53e3e`,
    color: '#e53e3e', borderRadius: 6, padding: '0.35rem 0.75rem',
    fontSize: '0.8rem', cursor: 'pointer', whiteSpace: 'nowrap',
  },
  // MFA enrollment card
  enrollCard: {
    background: colors.white, borderRadius: 12,
    padding: '1.25rem', border: `1px solid ${colors.green.primary}`,
    marginTop: 16, maxWidth: 380,
  },
  qrCode: { display: 'block', borderRadius: 8 },
  secretCode: {
    display: 'block', marginTop: 6, padding: '0.4rem 0.6rem',
    background: colors.gray[100], borderRadius: 6,
    fontSize: '0.78rem', wordBreak: 'break-all', fontFamily: 'monospace',
  },
  recoveryCodes: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  recoveryCode: {
    background: colors.gray[100], padding: '0.25rem 0.5rem',
    borderRadius: 4, fontSize: '0.75rem', fontFamily: 'monospace',
  },
  otpInput: {
    width: 110, padding: '0.45rem 0.7rem', borderRadius: 8,
    border: `1px solid ${colors.gray[400]}`, fontSize: '1.2rem',
    fontFamily: 'monospace', letterSpacing: '0.2em', textAlign: 'center' as const,
  },
  // Addresses
  addrList: { display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 8 },
  addrCard: {
    background: colors.white, borderRadius: 10,
    padding: '1rem', border: `1px solid ${colors.gray[200]}`,
    minWidth: 180, maxWidth: 240,
  },
  addrLabel: { fontWeight: 700, fontSize: '0.85rem', color: colors.green.primary, marginBottom: 6 },
  addrLine: { fontSize: '0.82rem', color: colors.text.secondary, lineHeight: 1.5 },
  addrForm: {
    background: colors.white, borderRadius: 12,
    padding: '1.25rem', border: `1px solid ${colors.gray[200]}`,
    marginTop: 12,
  },
};
