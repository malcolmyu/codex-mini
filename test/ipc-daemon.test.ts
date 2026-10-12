import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { IpcDaemon, type RuntimeController } from '../src/ipc/daemon.js';
import { IPC_VERSION, type BridgeStatus } from '../src/ipc/protocol.js';

class FakeRuntime implements RuntimeController {
  private listeners = new Set<(status: BridgeStatus) => void>();
  status: BridgeStatus = {
    protocolVersion: IPC_VERSION,
    lifecycle: 'stopped',
    weixin: 'disconnected',
    codex: 'disconnected',
    cwd: '/project',
    updatedAt: '2026-10-12T00:00:00.000Z',
  };

  currentStatus() { return { ...this.status }; }
  async start(cwd?: string) {
    this.status = { ...this.status, lifecycle: 'running', weixin: 'connected', codex: 'connected', cwd: cwd ?? this.status.cwd };
    for (const listener of this.listeners) listener(this.currentStatus());
    return this.currentStatus();
  }
  async stop() {
    this.status = { ...this.status, lifecycle: 'stopped', weixin: 'disconnected', codex: 'disconnected' };
    return this.currentStatus();
  }
  onStatus(listener: (status: BridgeStatus) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}

const streams: PassThrough[] = [];
afterEach(() => streams.splice(0).forEach((stream) => stream.destroy()));

describe('IpcDaemon', () => {
  it('serves status, starts the runtime, and shuts down', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    streams.push(input, output);
    const chunks: string[] = [];
    output.on('data', (chunk) => chunks.push(chunk.toString()));
    const run = new IpcDaemon(new FakeRuntime(), input, output).run();

    input.write('{"v":1,"id":"1","type":"status.get"}\n');
    input.write('{"v":1,"id":"2","type":"bridge.start","cwd":"/next"}\n');
    input.write('{"v":1,"id":"3","type":"shutdown"}\n');
    await run;

    const messages = chunks.join('').trim().split('\n').map((line) => JSON.parse(line));
    expect(messages[0].event).toBe('daemon.ready');
    expect(messages.find((message) => message.id === '1').result.lifecycle).toBe('stopped');
    expect(messages.find((message) => message.event === 'status.changed').data.cwd).toBe('/next');
    expect(messages.find((message) => message.id === '2').result.lifecycle).toBe('running');
    expect(messages.find((message) => message.id === '3').ok).toBe(true);
  });
});
