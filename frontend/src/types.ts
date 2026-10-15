export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface User {
  sub: string;
  name: string;
  email: string;
  picture?: string;
  loyaltyId?: string | number;
  loyaltyPoints?: number;
}

export interface UserProfile extends User {
  phone: string;
  user_metadata: Record<string, unknown>;
}

export interface Address {
  id: string;
  label: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export interface MfaFactor {
  id: string;
  type: string;
  name?: string;
  confirmed: boolean;
  created_at: string;
}

export interface LoyaltyData {
  loyaltyId: number | string;
  customeridentifier: string;
  totalPoints: number;
}

export interface PaymentMethod {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  name: string;
  isDefault: boolean;
}

export interface OrderSummary {
  id: string;
  createdAt: string | null;
  currency: string;
  totalCents: number | null;
  status: string;
  statuses: string[];
  items: Array<{ title: string; quantity: number; status: string }>;
}

export interface OrderTotal { type: string; amountCents: number }

export interface OrderDetail extends OrderSummary {
  buyerEmail: string | null;
  checkoutId: string | null;
  totals: OrderTotal[];
  lineItems: Array<{
    id: string;
    itemId: string | null;
    title: string;
    unitPriceCents: number;
    quantity: number;
    fulfilled: number;
    status: string;
    totals: OrderTotal[];
  }>;
  fulfillment: {
    expectations: Array<{
      id?: string;
      description?: string;
      method_type?: string;
      destination?: {
        street_address?: string; address_locality?: string; address_region?: string;
        postal_code?: string; address_country?: string;
      };
    }>;
    events: Array<{ type?: string; description?: string; occurred_at?: string; [k: string]: unknown }>;
  };
}
