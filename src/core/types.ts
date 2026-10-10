import type * as acp from '@agentclientprotocol/sdk';

export interface IncomingMessage {
  conversationId: string;
  senderId: string;
  text: string;
  contextToken?: string;
  messageId?: string;
}

export interface OutgoingMessage {
  conversationId: string;
  text: string;
  contextToken?: string;
}

export interface MessageChannel {
  send(message: OutgoingMessage): Promise<void>;
}

export interface SessionBinding {
  sessionId: string;
  cwd: string;
  updatedAt: string;
}

export interface BridgeState {
  conversations: Record<string, SessionBinding>;
}

export interface PermissionPrompt {
  request: acp.RequestPermissionRequest;
  resolve: (response: acp.RequestPermissionResponse) => void;
}

export interface CodexSessionSummary {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
}

export interface CodexAgent {
  start(): Promise<void>;
  stop(): Promise<void>;
  createSession(cwd: string): Promise<string>;
  loadSession(sessionId: string, cwd: string): Promise<void>;
  listSessions(cwd?: string): Promise<CodexSessionSummary[]>;
  prompt(sessionId: string, text: string): Promise<string>;
  cancel(sessionId: string): Promise<void>;
  setPermissionHandler(handler: (request: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>): void;
}
