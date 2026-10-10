import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BridgeState, SessionBinding } from './types.js';

const EMPTY_STATE: BridgeState = { conversations: {} };

function validState(value: unknown): value is BridgeState {
  if (!value || typeof value !== 'object') return false;
  const conversations = (value as { conversations?: unknown }).conversations;
  if (!conversations || typeof conversations !== 'object' || Array.isArray(conversations)) return false;
  return Object.values(conversations).every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const candidate = entry as Partial<SessionBinding>;
    return typeof candidate.sessionId === 'string'
      && typeof candidate.cwd === 'string'
      && typeof candidate.updatedAt === 'string';
  });
}

export class StateStore {
  constructor(private readonly path: string) {}

  async read(): Promise<BridgeState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!validState(parsed)) throw new Error(`Invalid bridge state: ${this.path}`);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY_STATE);
      throw error;
    }
  }

  async binding(conversationId: string): Promise<SessionBinding | undefined> {
    return (await this.read()).conversations[conversationId];
  }

  async bind(conversationId: string, binding: SessionBinding): Promise<void> {
    const state = await this.read();
    state.conversations[conversationId] = binding;
    await this.write(state);
  }

  async unbind(conversationId: string): Promise<void> {
    const state = await this.read();
    delete state.conversations[conversationId];
    await this.write(state);
  }

  private async write(state: BridgeState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
