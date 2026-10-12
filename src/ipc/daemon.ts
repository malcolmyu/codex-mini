import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { encodeMessage, IPC_VERSION, parseRequest, type BridgeStatus, type IpcEvent, type IpcResponse } from './protocol.js';

export interface RuntimeController {
  currentStatus(): BridgeStatus;
  start(cwd?: string): Promise<BridgeStatus>;
  stop(): Promise<BridgeStatus>;
  onStatus(listener: (status: BridgeStatus) => void): () => void;
}

export class IpcDaemon {
  private shuttingDown = false;

  constructor(
    private readonly runtime: RuntimeController,
    private readonly input: Readable,
    private readonly output: Writable,
  ) {}

  async run(): Promise<void> {
    const unsubscribe = this.runtime.onStatus((status) => this.event('status.changed', status));
    this.event('daemon.ready', { pid: process.pid, status: this.runtime.currentStatus() });
    const lines = createInterface({ input: this.input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        await this.handle(line);
        if (this.shuttingDown) break;
      }
    } finally {
      unsubscribe();
      await this.runtime.stop();
      lines.close();
    }
  }

  private async handle(line: string): Promise<void> {
    let id = 'invalid';
    try {
      const request = parseRequest(line);
      id = request.id;
      switch (request.type) {
        case 'ping':
          this.response(id, { pong: true, pid: process.pid });
          break;
        case 'status.get':
          this.response(id, this.runtime.currentStatus());
          break;
        case 'bridge.start':
          this.response(id, await this.runtime.start(request.cwd));
          break;
        case 'bridge.stop':
          this.response(id, await this.runtime.stop());
          break;
        case 'shutdown':
          this.response(id, await this.runtime.stop());
          this.shuttingDown = true;
          break;
      }
    } catch (error) {
      this.write({
        v: IPC_VERSION,
        id,
        ok: false,
        error: { code: 'invalid_request', message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private response(id: string, result: unknown): void {
    this.write({ v: IPC_VERSION, id, ok: true, result });
  }

  private event(event: IpcEvent['event'], data: unknown): void {
    this.write({ v: IPC_VERSION, event, data });
  }

  private write(message: IpcResponse | IpcEvent): void {
    this.output.write(encodeMessage(message));
  }
}
