# Floating Widget Polish Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show the 5-hour reset countdown in the compact widget and improve the expanded widget drag target and rounded shape.

**Architecture:** Extract compact reset copy into a pure frontend utility so countdown edge cases can be tested without mounting Tauri. Keep the existing status data flow unchanged; React only swaps the compact subtitle, while CSS owns the larger drag region and window clipping.

**Tech Stack:** React, TypeScript, CSS, Vitest, Tauri 2.

---

### Task 1: Compact reset countdown

**Files:**
- Create: `apps/desktop/src/usage-format.ts`
- Create: `test/usage-format.test.ts`
- Modify: `apps/desktop/src/App.tsx`

**Step 1: Write the failing test**

Cover unknown reset time, elapsed reset time, minute-only output, and hour-plus-minute output for a pure `formatCompactReset` function.

**Step 2: Run test to verify it fails**

Run: `npm test -- --run test/usage-format.test.ts`

Expected: FAIL because `apps/desktop/src/usage-format.ts` does not exist.

**Step 3: Write minimal implementation**

Implement `formatCompactReset(resetsAt, nowMs)` and replace the compact widget subtitle with `formatCompactReset(status.usage?.primary?.resetsAt)`.

**Step 4: Run test to verify it passes**

Run: `npm test -- --run test/usage-format.test.ts`

Expected: PASS.

### Task 2: Expanded widget interaction and shape

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/styles.css`

**Step 1: Add a usage-window root class**

Add `usage-window` while `UsageWidget` is mounted and keep the existing `usage-compact` state class.

**Step 2: Expand the drag region**

Increase `.widget-head` to approximately 52px with intentional padding while leaving `.widget-actions` interactive.

**Step 3: Round and clip the expanded window**

Apply a 20px radius and overflow clipping to the usage window root; keep the compact pill radius override.

**Step 4: Build the frontend**

Run: `npm run build --workspace @codex-wechat/desktop`

Expected: production build succeeds.

### Task 3: Full verification and launch

**Files:**
- Verify only.

**Step 1: Run all checks**

Run: `source "$HOME/.nvm/nvm.sh" && nvm use && npm test && npm run desktop:check`

Expected: all tests pass and Rust check succeeds.

**Step 2: Build release bundles**

Run: `source "$HOME/.nvm/nvm.sh" && nvm use && npm run desktop:build`

Expected: `.app` and `.dmg` bundles are produced.

**Step 3: Restart release App**

Stop only this repository's running App and daemon with SIGTERM, launch the rebuilt `.app`, and verify both processes remain alive.

**Step 4: Commit**

Commit the feature and its tests without staging unrelated user changes.
