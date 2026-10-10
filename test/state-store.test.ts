import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StateStore } from '../src/core/state-store.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('StateStore', () => {
  it('persists a conversation binding atomically with private permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-wechat-state-'));
    roots.push(root);
    const path = join(root, 'nested', 'state.json');
    const store = new StateStore(path);
    await store.bind('wx-user', { sessionId: 'session-1', cwd: '/tmp/project', updatedAt: 'now' });

    expect(await store.binding('wx-user')).toEqual({ sessionId: 'session-1', cwd: '/tmp/project', updatedAt: 'now' });
    expect(JSON.parse(await readFile(path, 'utf8')).conversations['wx-user'].sessionId).toBe('session-1');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
