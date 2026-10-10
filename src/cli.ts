#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import qrcode from 'qrcode-terminal';
import { CodexAcpClient } from './acp/codex-client.js';
import { Bridge } from './core/bridge.js';
import { StateStore } from './core/state-store.js';
import { ConsoleChannel } from './mock-channel.js';
import { WeixinApi } from './weixin/api.js';
import { loadCredentials, saveCredentials, WeixinChannel } from './weixin/channel.js';

const projectRoot = process.env.CODEX_WECHAT_HOME
  ? resolve(process.env.CODEX_WECHAT_HOME)
  : process.cwd();
const dataDir = join(projectRoot, '.data');
const credentialsPath = join(dataDir, 'weixin-credentials.json');

function option(name: string): string | undefined {
  const exact = process.argv.indexOf(name);
  if (exact >= 0) return process.argv[exact + 1];
  return process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

function workspace(): string {
  return resolve(option('--cwd') ?? process.env.CODEX_WECHAT_CWD ?? process.cwd());
}

async function loginWeixin(): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const api = new WeixinApi();
  const login = await api.beginLogin();
  console.log('请用微信扫描二维码：');
  qrcode.generate(login.qrcodeUrl, { small: true }, (code) => console.log(code));
  console.log(login.qrcodeUrl);
  let lastStatus = '';
  while (true) {
    const response = await api.pollLogin(login.qrcode);
    const status = String(response.status ?? 'unknown');
    if (status !== lastStatus) console.log(`微信登录状态：${status}`);
    lastStatus = status;
    const credentials = api.credentialsFromLogin(response);
    if (credentials) {
      await saveCredentials(credentialsPath, credentials);
      console.log(`登录成功，凭据已保存到 ${credentialsPath}`);
      console.log(`Owner iLink ID: ${credentials.ownerUserId}`);
      return;
    }
    if (['expired', 'binded_redirect'].includes(status)) throw new Error(`微信二维码已失效：${status}`);
    if (status === 'need_verifycode' || status === 'verify_code_blocked') {
      throw new Error('本次登录要求验证码，POC 尚未实现验证码提交，请重新生成二维码或补充该流程。');
    }
    await new Promise((done) => setTimeout(done, 1_000));
  }
}

async function runMock(): Promise<void> {
  const channel = new ConsoleChannel();
  const codex = new CodexAcpClient();
  const bridge = new Bridge({
    codex,
    channel,
    state: new StateStore(join(dataDir, 'mock-bridge-state.json')),
    defaultCwd: workspace(),
    ownerId: 'mock-owner',
  });
  await bridge.start();
  const once = option('--once');
  if (once) {
    await bridge.accept({ conversationId: 'mock', senderId: 'mock-owner', text: once });
    await bridge.stop();
    return;
  }

  console.log(`Mock 模式已启动，工作区：${workspace()}`);
  console.log('直接输入消息，或输入 /help。Ctrl-C 退出。');
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const tasks = new Set<Promise<void>>();
  input.on('line', (line) => {
    let task: Promise<void>;
    task = bridge.accept({ conversationId: 'mock', senderId: 'mock-owner', text: line })
      .finally(() => tasks.delete(task));
    tasks.add(task);
  });
  await new Promise<void>((done) => input.once('close', done));
  await Promise.allSettled([...tasks]);
  await bridge.stop();
}

async function runWeixin(): Promise<void> {
  const credentials = await loadCredentials(credentialsPath);
  const channel = new WeixinChannel(
    new WeixinApi(),
    credentials,
    join(dataDir, 'weixin-runtime-state.json'),
  );
  const bridge = new Bridge({
    codex: new CodexAcpClient(),
    channel,
    state: new StateStore(join(dataDir, 'weixin-bridge-state.json')),
    defaultCwd: workspace(),
    ownerId: process.env.WEIXIN_OWNER_USER_ID ?? credentials.ownerUserId,
  });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  await bridge.start();
  console.log(`微信桥已启动，工作区：${workspace()}`);
  console.log(`仅接受 owner：${process.env.WEIXIN_OWNER_USER_ID ?? credentials.ownerUserId}`);
  try {
    await channel.run((message) => bridge.accept(message), controller.signal);
  } finally {
    await bridge.stop();
  }
}

function usage(): void {
  console.log(`codex-wechat-acp-poc

用法：
  npm run dev -- mock [--cwd /absolute/path] [--once "prompt"]
  npm run dev -- weixin login
  npm run dev -- weixin run [--cwd /absolute/path]

建议先运行 mock 模式，确认本机 Codex 登录与 ACP 正常。`);
}

async function main(): Promise<void> {
  const [command, subcommand] = process.argv.slice(2);
  if (command === 'mock') return runMock();
  if (command === 'weixin' && subcommand === 'login') return loginWeixin();
  if (command === 'weixin' && subcommand === 'run') return runWeixin();
  usage();
  if (command && !['help', '--help', '-h'].includes(command)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
