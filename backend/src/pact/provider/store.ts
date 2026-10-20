import { ConditionalCheckFailedException, DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';

// Everything the Provider persists, in one DynamoDB table (pk, sk, ttl). Conditional writes
// stand in for the unique constraints and row locks the reference Provider gets from Postgres.

export type Platform = {
  id: string;
  name: string;
  issuer: string;
  jwksUri: string;
  enabled: boolean;
  audience: string | null;
};

export type Role = 'ROLE_USER' | 'ROLE_AGENT';
export type StoredMessage = {
  seq: number;
  messageId: string;
  role: Role;
  parts: unknown[];
  metadata?: Record<string, unknown> | null;
  createdAt: string;
};
export type Conversation = {
  contextId: string;
  brandId: string;
  userId: string; // (platform, sub): who the personal agent says it is acting for
  brandUserId?: string; // set once a turn ran under a delegation token
  msgCount: number;
  createdAt: string;
  updatedAt: string;
};

export type DeviceStatus = 'pending' | 'approved' | 'denied' | 'consumed';
export type DeviceAuthorization = {
  deviceHash: string;
  brandId: string;
  platformIssuer: string;
  clientId: string;
  userCode: string;
  requestedScope: string;
  status: DeviceStatus;
  brandUserId?: string;
  grantId?: string;
  intervalSeconds: number;
  lastPolledAtMs?: number;
  expiresAtMs: number;
};

export type Grant = {
  id: string;
  brandId: string;
  platformIssuer: string;
  clientId: string;
  brandUserId: string;
  scope: string;
  expiresAtMs: number;
  revokedAtMs?: number;
  createdAtMs: number;
};

export class TurnConflict extends Error {}

const DAY = 24 * 3600;
const pad = (n: number) => String(n).padStart(6, '0');
const ttl = (now: Date, seconds: number) => Math.floor(now.getTime() / 1000) + seconds;

export function createDocClient(): DynamoDBDocumentClient {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  return DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: process.env.AWS_REGION || 'us-east-1',
      ...(endpoint ? { endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
    }),
    { marshallOptions: { removeUndefinedValues: true } }
  );
}

export class PactStore {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly table: string
  ) {}

  private async get<T>(pk: string, sk = 'META'): Promise<T | undefined> {
    const out = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { pk, sk }, ConsistentRead: true }));
    return out.Item as T | undefined;
  }

  // ---- personal-agent platforms (spec §3.1) ----

  async getPlatformByIssuer(issuer: string): Promise<Platform | undefined> {
    const item = await this.get<Platform & { pk: string }>(`PLATFORM#${issuer}`);
    if (!item) return undefined;
    const { id, name, jwksUri, enabled, audience } = item;
    return { id, name, issuer, jwksUri, enabled, audience: audience ?? null };
  }

  async getPlatformByName(name: string): Promise<Platform | undefined> {
    const lock = await this.get<{ issuer: string }>(`PLATFORMNAME#${name}`);
    return lock ? this.getPlatformByIssuer(lock.issuer) : undefined;
  }

  /** Creates the platform and its name lock together; false when either is already taken. */
  async createPlatform(input: { name: string; issuer: string; jwksUri: string }): Promise<Platform | false> {
    const platform: Platform = { id: randomUUID(), ...input, enabled: true, audience: null };
    try {
      await this.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: { pk: `PLATFORM#${input.issuer}`, sk: 'META', ...platform },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { pk: `PLATFORMNAME#${input.name}`, sk: 'META', issuer: input.issuer },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        })
      );
      return platform;
    } catch (err) {
      if (err instanceof TransactionCanceledException) return false;
      throw err;
    }
  }

  async setPlatformEnabled(issuer: string, enabled: boolean): Promise<void> {
    await this.ddb.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: `PLATFORM#${issuer}`, sk: 'META' },
        UpdateExpression: 'SET enabled = :e',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':e': enabled },
      })
    );
  }

  // ---- conversations and messages (spec §4) ----

  async getConversation(contextId: string): Promise<Conversation | undefined> {
    const item = await this.get<Conversation & { pk: string; sk: string; ttl: number }>(`CONV#${contextId}`);
    if (!item) return undefined;
    const { pk: _pk, sk: _sk, ttl: _ttl, ...conversation } = item;
    return conversation;
  }

  async getMessages(contextId: string): Promise<StoredMessage[]> {
    const messages: StoredMessage[] = [];
    let key: Record<string, unknown> | undefined;
    do {
      const out = await this.ddb.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :m)',
          ExpressionAttributeValues: { ':pk': `CONV#${contextId}`, ':m': 'MSG#' },
          ConsistentRead: true,
          ExclusiveStartKey: key,
        })
      );
      for (const item of out.Items ?? []) {
        const { seq, messageId, role, parts, metadata, createdAt } = item as StoredMessage;
        messages.push({ seq, messageId, role, parts, metadata, createdAt });
      }
      key = out.LastEvaluatedKey;
    } while (key);
    return messages.sort((a, b) => a.seq - b.seq);
  }

  /** Opens a conversation with no messages, so a step-up task can name a context that stays open. */
  async createConversation(conversation: Conversation, now: Date): Promise<void> {
    await this.ddb.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk: `CONV#${conversation.contextId}`, sk: 'META', ...conversation, ttl: ttl(now, 30 * DAY) },
        ConditionExpression: 'attribute_not_exists(pk)',
      })
    );
  }

  /**
   * Writes one turn (user message + agent reply + dedupe marker + conversation counter) atomically.
   * Throws TurnConflict if another request already took this messageId or advanced the conversation.
   */
  async commitTurn(input: {
    conversation: Conversation;
    exists: boolean;
    user: Omit<StoredMessage, 'seq'>;
    agent: Omit<StoredMessage, 'seq'>;
    brandUserId?: string;
    now: Date;
  }): Promise<void> {
    const { conversation: c, now } = input;
    const pk = `CONV#${c.contextId}`;
    const expires = ttl(now, 30 * DAY);
    const updatedAt = now.toISOString();
    const newCount = c.msgCount + 2;
    const brandUserId = input.brandUserId ?? c.brandUserId;
    const put = (sk: string, item: Record<string, unknown>) => ({
      Put: {
        TableName: this.table,
        Item: { pk, sk, ...item, ttl: expires },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    });
    const meta = input.exists
      ? {
          Update: {
            TableName: this.table,
            Key: { pk, sk: 'META' },
            UpdateExpression: 'SET msgCount = :n, updatedAt = :u, brandUserId = :b, #t = :ttl',
            ConditionExpression: 'msgCount = :old',
            ExpressionAttributeNames: { '#t': 'ttl' },
            ExpressionAttributeValues: { ':n': newCount, ':u': updatedAt, ':b': brandUserId ?? null, ':old': c.msgCount, ':ttl': expires },
          },
        }
      : put('META', { ...c, brandUserId, msgCount: newCount, updatedAt });
    try {
      await this.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            put(`MID#${input.user.messageId}`, { seq: c.msgCount }),
            put(`MSG#${pad(c.msgCount)}`, { ...input.user, seq: c.msgCount }),
            put(`MSG#${pad(c.msgCount + 1)}`, { ...input.agent, seq: c.msgCount + 1 }),
            meta,
          ],
        })
      );
    } catch (err) {
      if (err instanceof TransactionCanceledException) throw new TurnConflict('Conversation changed during the turn');
      throw err;
    }
  }

  // ---- device authorizations (RFC 8628, spec §5.3) ----

  async createDeviceAuthorization(d: Omit<DeviceAuthorization, 'status'>, now: Date): Promise<boolean> {
    const expires = ttl(now, 3600);
    try {
      await this.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: { pk: `USERCODE#${d.userCode}`, sk: 'META', deviceHash: d.deviceHash, ttl: expires },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { pk: `DEVICE#${d.deviceHash}`, sk: 'META', ...d, status: 'pending', ttl: expires },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        })
      );
      return true;
    } catch (err) {
      if (err instanceof TransactionCanceledException) return false; // user_code collision: caller retries
      throw err;
    }
  }

  async getDevice(deviceHash: string): Promise<DeviceAuthorization | undefined> {
    return this.get<DeviceAuthorization>(`DEVICE#${deviceHash}`);
  }

  async getDeviceByUserCode(userCode: string): Promise<DeviceAuthorization | undefined> {
    const pointer = await this.get<{ deviceHash: string }>(`USERCODE#${userCode}`);
    return pointer ? this.getDevice(pointer.deviceHash) : undefined;
  }

  async touchPoll(deviceHash: string, at: Date): Promise<void> {
    await this.ddb.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: `DEVICE#${deviceHash}`, sk: 'META' },
        UpdateExpression: 'SET lastPolledAtMs = :t',
        ExpressionAttributeValues: { ':t': at.getTime() },
      })
    );
  }

  /** The user said no. Only a still-pending request can be denied. */
  async denyDevice(deviceHash: string, brandUserId: string): Promise<boolean> {
    return this.transition(deviceHash, 'pending', 'denied', { brandUserId });
  }

  /** Approves the request and records the grant in one transaction. */
  async approveDevice(deviceHash: string, grant: Grant, now: Date): Promise<boolean> {
    try {
      await this.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: { pk: `DEVICE#${deviceHash}`, sk: 'META' },
                UpdateExpression: 'SET #s = :approved, brandUserId = :u, grantId = :g',
                ConditionExpression: '#s = :pending',
                ExpressionAttributeNames: { '#s': 'status' },
                ExpressionAttributeValues: { ':approved': 'approved', ':pending': 'pending', ':u': grant.brandUserId, ':g': grant.id },
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { pk: `GRANT#${grant.id}`, sk: 'META', ...grant, ttl: Math.floor(grant.expiresAtMs / 1000) + 7 * DAY },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        })
      );
      return true;
    } catch (err) {
      if (err instanceof TransactionCanceledException) return false;
      throw err;
    }
  }

  /** Marks an approved device code as spent and returns it; undefined if it was not approved (or already spent). */
  async consumeDevice(deviceHash: string): Promise<DeviceAuthorization | undefined> {
    return this.transition(deviceHash, 'approved', 'consumed', {}, true);
  }

  private async transition(deviceHash: string, from: DeviceStatus, to: DeviceStatus, extra: { brandUserId?: string }, returnItem?: false): Promise<boolean>;
  private async transition(deviceHash: string, from: DeviceStatus, to: DeviceStatus, extra: { brandUserId?: string }, returnItem: true): Promise<DeviceAuthorization | undefined>;
  private async transition(
    deviceHash: string,
    from: DeviceStatus,
    to: DeviceStatus,
    extra: { brandUserId?: string },
    returnItem = false
  ): Promise<boolean | DeviceAuthorization | undefined> {
    try {
      const out = await this.ddb.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: `DEVICE#${deviceHash}`, sk: 'META' },
          UpdateExpression: 'SET #s = :to' + (extra.brandUserId ? ', brandUserId = :u' : ''),
          ConditionExpression: '#s = :from',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':to': to, ':from': from, ...(extra.brandUserId ? { ':u': extra.brandUserId } : {}) },
          ReturnValues: 'ALL_NEW',
        })
      );
      return returnItem ? (out.Attributes as DeviceAuthorization) : true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return returnItem ? undefined : false;
      throw err;
    }
  }

  // ---- grants and refresh tokens ----

  async getGrant(id: string): Promise<Grant | undefined> {
    return this.get<Grant>(`GRANT#${id}`);
  }

  async revokeGrant(id: string, at: Date): Promise<void> {
    await this.ddb.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: `GRANT#${id}`, sk: 'META' },
        UpdateExpression: 'SET revokedAtMs = :t',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':t': at.getTime() },
      })
    );
  }

  async putRefreshToken(tokenHash: string, grantId: string, expiresAtMs: number): Promise<void> {
    await this.ddb.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk: `REFRESH#${tokenHash}`, sk: 'META', grantId, expiresAtMs, ttl: Math.floor(expiresAtMs / 1000) + DAY },
        ConditionExpression: 'attribute_not_exists(pk)',
      })
    );
  }

  /** Spends a refresh token. Each one works once; returns its grant id, or undefined if unknown, used or expired. */
  async useRefreshToken(tokenHash: string, now: Date): Promise<string | undefined> {
    try {
      const out = await this.ddb.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: `REFRESH#${tokenHash}`, sk: 'META' },
          UpdateExpression: 'SET usedAtMs = :t',
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(usedAtMs) AND expiresAtMs > :t',
          ExpressionAttributeValues: { ':t': now.getTime() },
          ReturnValues: 'ALL_NEW',
        })
      );
      return out.Attributes?.grantId as string;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return undefined;
      throw err;
    }
  }

  // ---- login assertions ----

  /** First use of an assertion `jti` wins; a replay returns false. */
  async claimAssertion(jti: string, now: Date): Promise<boolean> {
    try {
      await this.ddb.send(
        new PutCommand({
          TableName: this.table,
          Item: { pk: `ASSERTION#${jti}`, sk: 'META', ttl: ttl(now, 900) },
          ConditionExpression: 'attribute_not_exists(pk)',
        })
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }
}
