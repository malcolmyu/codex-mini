# Phase 1 implementation plan: Tauri shell and bridge daemon

## Scope

Build the first executable slice of the approved desktop design. This phase stops at a working macOS menu-bar development app supervising the existing bridge over versioned stdio IPC. Usage reminders, Keychain migration, release signing, and standalone Node packaging remain later phases.

## Step 1: Versioned bridge daemon IPC

- Output:
  - Versioned JSON-lines request, response, and event protocol.
  - A long-running daemon entry point with `ping`, `status.get`, `bridge.start`, `bridge.stop`, and `shutdown` commands.
  - A runtime wrapper that starts and stops the existing Weixin + ACP bridge without duplicating CLI logic.
  - Protocol and daemon lifecycle tests.
- Verification:
  - `npm run check`
  - Spawn compiled daemon, send `ping` and `status.get`, then cleanly shut it down.

## Step 2: Tauri v2 + React application skeleton

- Output:
  - `apps/desktop` workspace with Vite, React, TypeScript, and Tauri v2.
  - Minimal status window showing bridge, Weixin, and Codex states.
  - Rust commands for reading status and restarting the bridge.
  - Single-instance and autostart plugin wiring.
- Verification:
  - Frontend TypeScript build.
  - `cargo check` for the Tauri crate.

## Step 3: Menu bar and sidecar supervision

- Output:
  - Menu-bar icon with Open, Restart Bridge, and Quit actions.
  - Rust-owned Node sidecar process with stdio IPC, status event forwarding, clean shutdown, and bounded restart backoff.
  - Window close hides the window instead of quitting the app.
- Verification:
  - Rust unit tests for line parsing and restart policy.
  - Launch Tauri in development mode and visually verify the status window and menu.
  - Kill the daemon once and verify a restart/status transition.

## Step 4: Development workflow and handoff

- Output:
  - Root scripts for desktop build/dev/check.
  - README instructions and known Phase 1 limitations.
  - No plaintext credential migration or release packaging claims.
- Verification:
  - `npm run check`
  - `npm run desktop:check`
  - clean `git diff --check`
