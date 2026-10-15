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
