import { describe, expect, it } from 'vitest';
import { encodeMessage, parseRequest } from '../src/ipc/protocol.js';

describe('IPC protocol', () => {
  it('parses a versioned bridge start request', () => {
    expect(parseRequest('{"v":1,"id":"42","type":"bridge.start","cwd":"/project"}')).toEqual({
      v: 1,
      id: '42',
      type: 'bridge.start',
      cwd: '/project',
    });
  });

  it('rejects unknown protocol versions and commands', () => {
    expect(() => parseRequest('{"v":2,"id":"42","type":"ping"}')).toThrow('Unsupported IPC version');
    expect(() => parseRequest('{"v":1,"id":"42","type":"destroy"}')).toThrow('Unsupported request type');
  });

  it('encodes exactly one JSON line', () => {
    const line = encodeMessage({ v: 1, id: '42', ok: true, result: { pong: true } });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
  });
});
