import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { quarantineCredentials } from '../src/weixin/channel.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe('Weixin credential recovery', () => {
  it('moves stale credentials aside so the next start requires a fresh QR login', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-weixin-credentials-'));
    directories.push(directory);
    const credentialsPath = join(directory, 'weixin-credentials.json');
    await writeFile(credentialsPath, '{"token":"expired"}\n');

    const quarantinePath = await quarantineCredentials(
      credentialsPath,
      new Date('2026-10-19T06:00:00.000Z'),
    );

    await expect(access(credentialsPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(quarantinePath).toContain('.stale-2026-10-19T06-00-00-000Z');
    expect(await readFile(quarantinePath!, 'utf8')).toContain('expired');
  });
});
