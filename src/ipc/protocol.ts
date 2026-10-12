export const IPC_VERSION = 1 as const;

export type BridgeLifecycle = 'stopped' | 'starting' | 'running' | 'stopping' | 'needs_login' | 'error';

export interface BridgeStatus {
  protocolVersion: typeof IPC_VERSION;
  lifecycle: BridgeLifecycle;
  weixin: 'disconnected' | 'connecting' | 'connected' | 'needs_login' | 'error';
  codex: 'disconnected' | 'connecting' | 'connected' | 'error';
  cwd: string;
  updatedAt: string;
  lastError?: string;
}

export type IpcRequest =
  | { v: typeof IPC_VERSION; id: string; type: 'ping' }
  | { v: typeof IPC_VERSION; id: string; type: 'status.get' }
  | { v: typeof IPC_VERSION; id: string; type: 'bridge.start'; cwd?: string }
  | { v: typeof IPC_VERSION; id: string; type: 'bridge.stop' }
  | { v: typeof IPC_VERSION; id: string; type: 'shutdown' };

export interface IpcResponse {
  v: typeof IPC_VERSION;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface IpcEvent {
  v: typeof IPC_VERSION;
  event: 'daemon.ready' | 'status.changed';
  data: unknown;
}

const requestTypes = new Set(['ping', 'status.get', 'bridge.start', 'bridge.stop', 'shutdown']);

export function parseRequest(line: string): IpcRequest {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('Request is not valid JSON');
  }
  if (!value || typeof value !== 'object') throw new Error('Request must be an object');
  const request = value as Record<string, unknown>;
  if (request.v !== IPC_VERSION) throw new Error(`Unsupported IPC version: ${String(request.v)}`);
  if (typeof request.id !== 'string' || !request.id.trim()) throw new Error('Request id is required');
  if (typeof request.type !== 'string' || !requestTypes.has(request.type)) {
    throw new Error(`Unsupported request type: ${String(request.type)}`);
  }
  if (request.cwd !== undefined && typeof request.cwd !== 'string') throw new Error('cwd must be a string');
  return request as unknown as IpcRequest;
}

export function encodeMessage(message: IpcResponse | IpcEvent): string {
  return `${JSON.stringify(message)}\n`;
}
