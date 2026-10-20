import { Router } from 'express';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { requireAuth } from '../middleware/requireAuth';

// Orders are written by the UCP merchant server. Each row is
// { id, buyer_sub, buyer_email, created_at, data: <UCP order> }.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ORDERS_TABLE = process.env.UCP_ORDERS_TABLE || 'ucp-merchant-server-orders';
const BUYER_INDEX = 'buyer-sub-index';

type UcpLineItem = {
  id: string;
  item?: { id?: string; title?: string; price?: string | number };
  quantity?: { total?: string | number; fulfilled?: string | number };
  status?: string;
  totals?: Array<{ type: string; amount: string | number }>;
};
type UcpOrder = {
  id: string;
  currency?: string;
  line_items?: UcpLineItem[];
  totals?: Array<{ type: string; amount: string | number }>;
  fulfillment?: { expectations?: unknown[]; events?: unknown[] };
  [k: string]: unknown;
};
export type OrderRow = { id: string; buyer_sub?: string; buyer_email?: string; created_at?: string; data?: UcpOrder };

// The merchant server stores some numbers as strings; normalise to integers (cents).
const num = (v: unknown): number => (v === undefined || v === null ? 0 : Number(v));

export function summarize(row: OrderRow) {
  const o = row.data ?? ({ id: row.id } as UcpOrder);
  const items = o.line_items ?? [];
  const statuses = [...new Set(items.map((l) => l.status ?? 'unknown'))];
  const total = (o.totals ?? []).find((t) => t.type === 'total');
  return {
    id: row.id,
    createdAt: row.created_at ?? null,
    currency: o.currency ?? 'USD',
    totalCents: total ? num(total.amount) : null,
    status: statuses.length === 1 ? statuses[0] : statuses.length ? 'mixed' : 'unknown',
    statuses,
    items: items.map((l) => ({
      title: l.item?.title ?? l.item?.id ?? 'Item',
      quantity: num(l.quantity?.total),
      status: l.status ?? 'unknown',
    })),
  };
}

export function detail(row: OrderRow) {
  const o = row.data ?? ({ id: row.id } as UcpOrder);
  return {
    ...summarize(row),
    buyerEmail: row.buyer_email ?? null,
    checkoutId: o.checkout_id ?? null,
    totals: (o.totals ?? []).map((t) => ({ type: t.type, amountCents: num(t.amount) })),
    lineItems: (o.line_items ?? []).map((l) => ({
      id: l.id,
      itemId: l.item?.id ?? null,
      title: l.item?.title ?? l.item?.id ?? 'Item',
      unitPriceCents: num(l.item?.price),
      quantity: num(l.quantity?.total),
      fulfilled: num(l.quantity?.fulfilled),
      status: l.status ?? 'unknown',
      totals: (l.totals ?? []).map((t) => ({ type: t.type, amountCents: num(t.amount) })),
    })),
    fulfillment: {
      expectations: o.fulfillment?.expectations ?? [],
      events: o.fulfillment?.events ?? [],
    },
  };
}

// All orders for a buyer, newest first.
export async function listOrderRows(sub: string): Promise<OrderRow[]> {
  const rows: OrderRow[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const out = await ddb.send(new QueryCommand({
      TableName: ORDERS_TABLE,
      IndexName: BUYER_INDEX,
      KeyConditionExpression: 'buyer_sub = :s',
      ExpressionAttributeValues: { ':s': sub },
      ScanIndexForward: false,
      ExclusiveStartKey: key,
    }));
    rows.push(...((out.Items ?? []) as OrderRow[]));
    key = out.LastEvaluatedKey;
  } while (key);
  return rows;
}

// One order, or undefined if missing or owned by someone else (callers return 404, not 403).
export async function getOrderRow(sub: string, id: string): Promise<OrderRow | undefined> {
  const out = await ddb.send(new GetCommand({ TableName: ORDERS_TABLE, Key: { id } }));
  const row = out.Item as OrderRow | undefined;
  return row?.buyer_sub && row.buyer_sub === sub ? row : undefined;
}

const router = Router();

// GET /api/orders?status=processing — the caller's orders, newest first
router.get('/orders', requireAuth, async (req, res) => {
  try {
    const rows = await listOrderRows(req.oidc!.user!.sub as string);
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const orders = rows.map(summarize).filter((o) => !status || o.statuses.includes(status));
    res.json(orders);
  } catch (err) {
    console.error('GET /orders error:', err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// GET /api/orders/:id — full detail; 404 (not 403) if the order belongs to someone else
router.get('/orders/:id', requireAuth, async (req, res) => {
  try {
    const row = await getOrderRow(req.oidc!.user!.sub as string, req.params.id);
    if (!row) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    res.json(detail(row));
  } catch (err) {
    console.error('GET /orders/:id error:', err);
    res.status(500).json({ error: 'Failed to load order' });
  }
});

export default router;
