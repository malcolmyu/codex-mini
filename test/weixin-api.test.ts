import { describe, expect, it, vi } from 'vitest';
import {
  extractWeixinText,
  isStaleWeixinTokenError,
  WEIXIN_LOGIN_POLL_TIMEOUT_MS,
  WeixinApi,
  type WeixinCredentials,
} from '../src/weixin/api.js';

const credentials: WeixinCredentials = {
  token: 'secret',
  botId: 'bot-1',
  ownerUserId: 'owner-1',
  baseUrl: 'https://ilinkai.weixin.qq.com/',
};

describe('WeixinApi', () => {
  it('uses a short timeout for QR login polling', () => {
    expect(WEIXIN_LOGIN_POLL_TIMEOUT_MS).toBe(5_000);
  });

  it('does not impose a short client timeout while requesting a QR code', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return new Response(JSON.stringify({
        qrcode: 'qr-1',
        qrcode_img_content: 'https://ilinkai.weixin.qq.com/qr/qr-1',
      }), { status: 200 });
    });
    const api = new WeixinApi(fetchMock as typeof fetch);

    await expect(api.beginLogin(controller.signal)).resolves.toMatchObject({ qrcode: 'qr-1' });
  });

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

  it('classifies a -14 response as an expired login', async () => {
    const fetchMock = vi.fn(async () => (
      new Response(JSON.stringify({ ret: -14, errmsg: 'token expired' }), { status: 200 })
    ));
    const api = new WeixinApi(fetchMock as typeof fetch);

    await expect(api.notifyStart(credentials)).rejects.toSatisfy(isStaleWeixinTokenError);
  });
});

describe('extractWeixinText', () => {
  it('extracts text and transcribed voice messages', () => {
    expect(extractWeixinText({ item_list: [{ type: 1, text_item: { text: ' hello ' } }] })).toBe('hello');
    expect(extractWeixinText({ item_list: [{ type: 3, voice_item: { text: 'voice' } }] })).toBe('voice');
  });
});
