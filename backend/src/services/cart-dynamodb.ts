import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.DYNAMODB_CARTS_TABLE!;

// 30-day TTL
const TTL_SECONDS = 30 * 24 * 60 * 60;

export interface CartItem {
  name: string;
  emoji: string;
  price: string;
  pointsCost: number;
  qty: number;
}

export interface Cart {
  userId: string;
  items: CartItem[];
  updatedAt: string;
}

export async function getCart(userId: string): Promise<Cart> {
  const result = await client.send(
    new GetCommand({ TableName: TABLE, Key: { userId } })
  );
  if (!result.Item) return { userId, items: [], updatedAt: new Date().toISOString() };
  return result.Item as Cart;
}

export async function upsertCart(
  userId: string,
  item: Omit<CartItem, 'qty'>
): Promise<Cart> {
  const existing = await getCart(userId);
  const idx = existing.items.findIndex(i => i.name === item.name);
  if (idx >= 0) {
    existing.items[idx].qty += 1;
  } else {
    existing.items.push({ ...item, qty: 1 });
  }
  const now = new Date().toISOString();
  const cart: Cart = { userId, items: existing.items, updatedAt: now };
  await client.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...cart,
        ttl: Math.floor(Date.now() / 1000) + TTL_SECONDS,
      },
    })
  );
  return cart;
}

export async function removeCartItem(userId: string, name: string): Promise<Cart> {
  const existing = await getCart(userId);
  const idx = existing.items.findIndex(i => i.name === name);
  if (idx >= 0) {
    if (existing.items[idx].qty > 1) {
      existing.items[idx].qty -= 1;
    } else {
      existing.items.splice(idx, 1);
    }
  }
  const now = new Date().toISOString();
  const cart: Cart = { userId, items: existing.items, updatedAt: now };
  await client.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...cart,
        ttl: Math.floor(Date.now() / 1000) + TTL_SECONDS,
      },
    })
  );
  return cart;
}

export async function upsertCartBulk(userId: string, items: CartItem[]): Promise<Cart> {
  const now = new Date().toISOString();
  const cart: Cart = { userId, items, updatedAt: now };
  await client.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...cart,
        ttl: Math.floor(Date.now() / 1000) + TTL_SECONDS,
      },
    })
  );
  return cart;
}

export async function clearCart(userId: string): Promise<void> {
  await client.send(new DeleteCommand({ TableName: TABLE, Key: { userId } }));
}
