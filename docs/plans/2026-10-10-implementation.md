# Implementation plan

## Step 1: ACP transport

- Output: child-process lifecycle, ACP initialization, session create/list/load, prompt streaming, cancellation, and permission callback.
- Test: unit-test event accumulation; live mock prompt through `codex-acp`.

## Step 2: bridge and persistence

- Output: conversation/session bindings and `/new`, `/tasks`, `/use`, `/stop` routing.
- Test: command-routing and atomic-state-store tests.

## Step 3: Weixin text transport

- Output: QR login, credential persistence, iLink long polling, owner filtering, text send, and chunking.
- Test: request-shape tests with a fake fetch implementation.

## Step 4: CLI and documentation

- Output: mock console, Weixin login/run commands, README, and environment example.
- Test: build, full test suite, CLI help, and real ACP smoke test.
