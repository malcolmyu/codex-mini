#!/usr/bin/env node
import { resolve } from 'node:path';
import { IpcDaemon } from './ipc/daemon.js';
import { BridgeRuntime } from './runtime.js';

const projectRoot = process.env.CODEX_WECHAT_HOME
  ? resolve(process.env.CODEX_WECHAT_HOME)
  : process.cwd();
const defaultCwd = resolve(process.env.CODEX_WECHAT_CWD ?? projectRoot);

const runtime = new BridgeRuntime({ projectRoot, defaultCwd });
const daemon = new IpcDaemon(runtime, process.stdin, process.stdout);

daemon.run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
