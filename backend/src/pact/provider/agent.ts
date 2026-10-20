import { createHash } from 'crypto';
import { ORDERS_READ } from '../config';
import type { ReceiptAction } from './tokens';

// The Brand's agent behind the PACT interface. Two rules shape it:
//  - Account data (orders) is only ever read through a delegation token that carries the scope.
//    Without one, the turn returns a step-up request instead of an answer or a refusal.
//  - Everything the personal agent sends is untrusted text. The model that answers general
//    questions gets no tools and no account data, so there is nothing for an injected
//    instruction to reach.

export type OrderSummary = {
  id: string;
  createdAt: string | null;
  currency: string;
  totalCents: number | null;
  status: string;
  items: { title: string; quantity: number; status: string }[];
};

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

export type AgentDeps = {
  generalReply(history: ChatTurn[]): Promise<string>;
  listOrders(brandUserId: string): Promise<OrderSummary[]>;
};

export type Delegation = { sub: string; scopes: string[] };

export type AgentResult =
  | { kind: 'stepUp'; missingScopes: string[]; text: string }
  | { kind: 'reply'; text: string; scopesUsed: string[]; actions: ReceiptAction[] };

export const ORDER_INTENT =
  /\b(my|latest|last|recent|recently|past|previous|current)\b[^.?!]*\b(orders?|purchases?|packages?|shipments?|deliver(?:y|ies))\b|\b(orders?|purchases?)\b[^.?!]*\b(status|history|placed|so far|arrive|arrived|shipped)\b|\bwhere('s| is)\b[^.?!]*\b(order|package|delivery)\b|\btrack\b[^.?!]*\b(order|package)\b/i;

function money(cents: number | null, currency: string): string {
  return cents === null ? 'total unavailable' : `${(cents / 100).toFixed(2)} ${currency}`;
}

function describeOrder(order: OrderSummary): string {
  const items = order.items.map((i) => `${i.quantity} x ${i.title}`).join(', ');
  const when = order.createdAt ? ` placed ${order.createdAt.slice(0, 10)}` : '';
  return `Order ${order.id}${when}: ${items || 'no items listed'} (${order.status}, ${money(order.totalCents, order.currency)})`;
}

export function summarizeOrders(orders: OrderSummary[]): string {
  if (orders.length === 0) return 'There are no orders on this account yet.';
  if (orders.length === 1) return `${describeOrder(orders[0])}.`;
  const earlier = orders.length - 1;
  return `Latest: ${describeOrder(orders[0])}. ${earlier} earlier order${earlier === 1 ? '' : 's'} on file.`;
}

export function argsHash(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(args)).digest('base64url');
}

export async function runAgentTurn(input: {
  text: string;
  history: ChatTurn[];
  delegation: Delegation | undefined;
  deps: AgentDeps;
}): Promise<AgentResult> {
  if (ORDER_INTENT.test(input.text)) {
    if (!input.delegation?.scopes.includes(ORDERS_READ)) {
      return { kind: 'stepUp', missingScopes: [ORDERS_READ], text: "I need permission to view the customer's orders." };
    }
    const orders = await input.deps.listOrders(input.delegation.sub);
    return {
      kind: 'reply',
      text: summarizeOrders(orders),
      scopesUsed: [ORDERS_READ],
      actions: [{ tool: 'list_orders' }],
    };
  }
  const text = await input.deps.generalReply([...input.history, { role: 'user', content: input.text }]);
  return { kind: 'reply', text, scopesUsed: [], actions: [] };
}
