export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface Conversation {
  conversationId: string;
  userId: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

export interface AuthSession {
  sessionId: string;
  userId: string;
  sid: string;
  revoked: boolean;
  createdAt: string;
}

declare module 'express-session' {
  interface SessionData {
    conversationId?: string;
  }
}
