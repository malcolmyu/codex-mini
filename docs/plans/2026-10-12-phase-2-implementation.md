# Phase 2 implementation plan: usage, pending tasks, and Weixin relogin

## Scope

Complete the user-visible POC loop that was intentionally left out of Phase 1: show real Codex quota in a floating macOS window, derive actionable unfinished tasks from local Codex metadata without calling a model, and allow a disconnected Weixin bridge to be restored by scanning a QR code in the desktop app.

## Step 1: Real Codex usage probe and floating window

- Output:
  - A one-shot app-server JSON-RPC client for `account/rateLimits/read`.
  - Usage snapshots on the daemon status protocol, including staleness and refresh errors.
  - A compact always-on-top Tauri window showing remaining 5-hour and weekly quota, reset times, and refresh state.
  - Manual refresh plus a ten-minute background refresh loop.
- Verification:
  - Unit-test response normalization and remaining-percentage calculations.
  - Compare a live probe result with the Codex host usage result.
  - Visually inspect the floating window.

## Step 2: Read-only task scan and reminder decision

- Output:
  - A read-only scanner for `state_5.sqlite` and `thread_history_1.sqlite`.
  - Deterministic scoring for failed, interrupted, stale in-progress, unanswered, and question-waiting tasks.
  - A pending-task list in the desktop UI and a balanced-policy eligibility result.
  - Persistent reminder snapshots, per-task overrides, cooldowns, and reply-number routing into `/use`.
- Verification:
  - SQLite fixture tests for all score and exclusion paths.
  - Reminder-policy boundary tests and snapshot reply tests.
  - Run against the local Codex databases in read-only mode and inspect candidate output.

## Step 3: Weixin QR relogin

- Output:
  - IPC command and status model for starting, polling, completing, expiring, and retrying Weixin login.
  - Locally rendered QR code in the settings window.
  - Successful credential save followed by automatic bridge startup.
  - A relogin action available while disconnected or from the tray menu.
- Verification:
  - Unit-test login state transitions with a fake Weixin API.
  - Visually verify QR rendering and retry/error states.
  - Verify an already valid credential keeps the normal startup path unchanged.

## Step 4: End-to-end reminder delivery and handoff

- Output:
  - Automatic reminder delivery only after usage, time-window, candidate, cooldown, and owner checks pass.
  - A 24-hour candidate snapshot in the reminder state store.
  - Weixin replies `1`, `/continue 1`, `忽略 1`, `稍后 1`, and `已解决 1` handled against that snapshot.
  - Updated README with development and manual acceptance instructions.
- Verification:
  - Fake-channel integration test for reminder delivery and reply routing.
  - Full TypeScript, frontend, Rust, and diff checks.
  - Manual desktop smoke test covering usage, tasks, and login states.
