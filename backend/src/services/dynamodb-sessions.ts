import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { AuthSession, Conversation, Message } from '../types';

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const ddb = DynamoDBDocumentClient.from(client);

const SESSIONS_TABLE = process.env.DYNAMODB_SESSIONS_TABLE!;
const CONVERSATIONS_TABLE = process.env.DYNAMODB_CONVERSATIONS_TABLE!;

// --- Auth Sessions ---

export async function recordSession(session: AuthSession): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: SESSIONS_TABLE,
    Item: session,
  }));
}

export async function getSessionBySessionId(sessionId: string): Promise<AuthSession | null> {
  const result = await ddb.send(new GetCommand({
    TableName: SESSIONS_TABLE,
    Key: { sessionId },
  }));
  return (result.Item as AuthSession) ?? null;
}

// Used by backchannel logout to find all sessions for a user by OIDC sid
export async function revokeSessionsBySid(sid: string): Promise<void> {
  const result = await ddb.send(new QueryCommand({
    TableName: SESSIONS_TABLE,
    IndexName: 'sid-index',
    KeyConditionExpression: 'sid = :sid',
    ExpressionAttributeValues: { ':sid': sid },
  }));

  const sessions = (result.Items ?? []) as AuthSession[];
  await Promise.all(
    sessions.map((s) =>
      ddb.send(new UpdateCommand({
        TableName: SESSIONS_TABLE,
        Key: { sessionId: s.sessionId },
        UpdateExpression: 'SET revoked = :revoked',
        ExpressionAttributeValues: { ':revoked': true },
      }))
    )
  );
}

export async function revokeSessionsByUserId(userId: string): Promise<void> {
  const result = await ddb.send(new QueryCommand({
    TableName: SESSIONS_TABLE,
    IndexName: 'userId-index',
    KeyConditionExpression: 'userId = :userId',
    ExpressionAttributeValues: { ':userId': userId },
  }));

  const sessions = (result.Items ?? []) as AuthSession[];
  await Promise.all(
    sessions.map((s) =>
      ddb.send(new UpdateCommand({
        TableName: SESSIONS_TABLE,
        Key: { sessionId: s.sessionId },
        UpdateExpression: 'SET revoked = :revoked',
        ExpressionAttributeValues: { ':revoked': true },
      }))
    )
  );
}

// --- Conversations ---

export async function getOrCreateConversation(
  conversationId: string,
  userId: string
): Promise<Conversation> {
  const result = await ddb.send(new GetCommand({
    TableName: CONVERSATIONS_TABLE,
    Key: { conversationId },
  }));

  if (result.Item) {
    return result.Item as Conversation;
  }

  const now = new Date().toISOString();
  const conversation: Conversation = {
    conversationId,
    userId,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  await ddb.send(new PutCommand({ TableName: CONVERSATIONS_TABLE, Item: conversation }));
  return conversation;
}

export async function appendMessage(
  conversationId: string,
  message: Message
): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: CONVERSATIONS_TABLE,
    Key: { conversationId },
    UpdateExpression:
      'SET messages = list_append(if_not_exists(messages, :empty), :msg), updatedAt = :now',
    ExpressionAttributeValues: {
      ':msg': [message],
      ':empty': [],
      ':now': new Date().toISOString(),
    },
  }));
}

export async function listConversations(userId: string): Promise<Conversation[]> {
  const result = await ddb.send(new QueryCommand({
    TableName: CONVERSATIONS_TABLE,
    IndexName: 'userId-index',
    KeyConditionExpression: 'userId = :userId',
    ExpressionAttributeValues: { ':userId': userId },
    ScanIndexForward: false,
  }));
  return (result.Items ?? []) as Conversation[];
}
