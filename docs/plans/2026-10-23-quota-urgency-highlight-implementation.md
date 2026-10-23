# Quota Urgency Highlight Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Highlight underused quota that will reset within 30 minutes while preserving the redesigned monochrome dual-ring orb.

**Architecture:** Derive urgency with a pure TypeScript helper from the existing usage window and a minute-level local clock. Feed separate primary and weekly urgency classes into the existing orb and meters, then express the warning entirely through CSS tokens, ring colors, one shared halo, and reduced-motion fallback.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Tauri 2.

---

### Task 1: Add a tested urgency classifier

**Files:**
- Modify: `apps/desktop/src/usage-format.ts`
- Modify: `test/usage-format.test.ts`

**Step 1: Write the failing boundary tests**

Import `isQuotaUrgent` and cover the accepted boundary, both rejected boundaries, elapsed timestamps, and missing data:

```ts
expect(isQuotaUrgent({ remainingPercent: 40, resetsAt: (now + 30 * 60_000) / 1_000 }, now)).toBe(true);
expect(isQuotaUrgent({ remainingPercent: 39, resetsAt: (now + 30 * 60_000) / 1_000 }, now)).toBe(false);
expect(isQuotaUrgent({ remainingPercent: 80, resetsAt: (now + 31 * 60_000) / 1_000 }, now)).toBe(false);
expect(isQuotaUrgent({ remainingPercent: 80, resetsAt: now / 1_000 }, now)).toBe(false);
expect(isQuotaUrgent(undefined, now)).toBe(false);
```

**Step 2: Run the focused test and verify it fails**

Run: `npm test -- --run test/usage-format.test.ts`

Expected: FAIL because `isQuotaUrgent` is not exported.

**Step 3: Implement the pure classifier**

Add an exported helper with defaults of 40 percent and 30 minutes. Require a finite future reset timestamp, inclusive threshold boundaries, and no dependency on React or bridge types.

**Step 4: Run the focused test and verify it passes**

Run: `npm test -- --run test/usage-format.test.ts`

Expected: all usage-format tests pass.

### Task 2: Derive live urgency in the redesigned widget

**Files:**
- Modify: `apps/desktop/src/App.tsx`

**Step 1: Add a minute clock**

Add a `nowMs` state initialized from `Date.now()` and update it every 60 seconds with an effect that clears its interval on unmount.

**Step 2: Classify each quota window**

Compute `primaryUrgent` and `secondaryUrgent` with `isQuotaUrgent`. Add `quota-urgent`, `primary-urgent`, and `secondary-urgent` classes to `.orb-stage` without changing its existing motion, direction, pin, or drag classes.

**Step 3: Mark the expanded meters**

Extend `UsageMeter` with an `urgent` prop. Add the `urgent` class and render `即将恢复，建议用掉 · <countdown>` for urgent meters; retain the existing copy otherwise.

**Step 4: Improve accessible status**

Append an urgency phrase to the orb `aria-label` only for the affected windows. Keep the visible compact value and countdown structure unchanged.

### Task 3: Add ring-specific amber emphasis and shared breathing motion

**Files:**
- Modify: `apps/desktop/src/styles.css`

**Step 1: Define warning tokens**

Add warm amber foreground, track, surface, border, and glow custom properties to `.orb-stage`, keeping the monochrome palette as the default.

**Step 2: Accent only the affected ring**

Override the outer conic gradient for `.secondary-urgent .usage-orb` and the inner `::before` gradient for `.primary-urgent .usage-orb`. Change the compact reset copy only for primary urgency.

**Step 3: Add one breathing halo**

Use a pseudo-element or animated box shadow on `.quota-urgent .usage-orb` with a 2.4-second ease-in-out animation. Keep the halo outside the quota rings and do not change the orb geometry.

**Step 4: Accent only the affected expanded meter**

Use a soft amber surface, border/inset divider, progress fill, and warning copy color on `.usage-meter.urgent` without changing layout dimensions.

**Step 5: Respect reduced motion**

Add the urgency animation to the existing `prefers-reduced-motion` override while retaining the static warning colors and halo.

### Task 4: Verify and deliver

**Files:**
- Verify: `apps/desktop/src/App.tsx`
- Verify: `apps/desktop/src/styles.css`
- Verify: `test/usage-format.test.ts`

**Step 1: Run focused and full checks**

Run:

```bash
source "$NVM_DIR/nvm.sh" && nvm use
npm test -- --run test/usage-format.test.ts
npm run build
npm test -- --maxWorkers=1 --fileParallelism=false
npm run desktop:check
git diff --check
```

Expected: all commands pass.

**Step 2: Build the debug app**

Run: `npm run tauri:build --workspace @codex-wechat/desktop -- --debug --bundles app`

Expected: a macOS app bundle is produced under `apps/desktop/src-tauri/target/debug/bundle/macos/`.

**Step 3: Visually inspect the rebuilt app**

Restart the debug bundle and inspect compact and expanded states. Use a temporary local fixture only if live quota does not satisfy the urgency condition; do not alter persisted credentials or bridge data.

**Step 4: Commit only urgency-related files**

Stage the two urgency plan documents plus the relevant portions of `App.tsx`, `styles.css`, `usage-format.ts`, and `test/usage-format.test.ts`. Preserve all unrelated user changes.
