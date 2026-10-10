import { describe, expect, it, vi } from 'vitest';
import { extractWeixinText, WeixinApi, type WeixinCredentials } from '../src/weixin/api.js';

const credentials: WeixinCredentials = {
  token: 'secret',
  botId: 'bot-1',
  ownerUserId: 'owner-1',
  baseUrl: 'https://ilinkai.weixin.qq.com/',
};

describe('WeixinApi', () => {
  it('builds the iLink text message request', async () => {
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.msg.to_user_id).toBe('owner-1');
      expect(body.msg.item_list[0].text_item.text).toBe('hello');
      expect(body.msg.context_token).toBe('context');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
    });
    const api = new WeixinApi(fetchMock as typeof fetch);
    await api.sendText(credentials, 'owner-1', 'hello', 'context');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('extractWeixinText', () => {
  it('extracts text and transcribed voice messages', () => {
    expect(extractWeixinText({ item_list: [{ type: 1, text_item: { text: ' hello ' } }] })).toBe('hello');
    expect(extractWeixinText({ item_list: [{ type: 3, voice_item: { text: 'voice' } }] })).toBe('voice');
  });
});
