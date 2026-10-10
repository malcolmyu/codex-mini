import { describe, expect, it } from 'vitest';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { ApprovalBroker } from '../src/core/approval-broker.js';

const request: RequestPermissionRequest = {
  sessionId: 'session-1',
  toolCall: { toolCallId: 'call-1', title: 'Run tests', kind: 'execute', status: 'pending' },
  options: [
    { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  ],
};

describe('ApprovalBroker', () => {
  it('maps an approval reply to an advertised option', async () => {
    const broker = new ApprovalBroker();
    const result = broker.wait('conversation', request);
    expect(broker.describe('conversation')).toContain('Run tests');
    expect(broker.answer('conversation', '/approve 1')).toBe(true);
    await expect(result).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } });
  });

  it('uses a reject option when present', async () => {
    const broker = new ApprovalBroker();
    const result = broker.wait('conversation', request);
    expect(broker.answer('conversation', '/reject')).toBe(true);
    await expect(result).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
  });
});
