# DSH Monochrome Orb Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the floating widget's blue-green glass styling with a coherent white and gray dsh-orb-inspired visual system while preserving all interaction behavior.

**Architecture:** Keep the React state machine and window geometry unchanged. Centralize the gray palette in `.orb-stage` CSS custom properties, then restyle the shell, content surfaces, controls, status elements, and orb using those tokens.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Tauri 2.

---

### Task 1: Define the monochrome palette

**Files:**
- Modify: `apps/desktop/src/styles.css`

**Step 1:** Replace blue-green shell variables with white, gray, border, text, and muted-text tokens.

**Step 2:** Replace the shell gradient with a solid white background and retain the dsh-orb border and shadow states.

**Step 3:** Search the widget CSS for obsolete blue-green values and verify that none remain in the floating widget rules.

### Task 2: Flatten the expanded panel

**Files:**
- Modify: `apps/desktop/src/styles.css`

**Step 1:** Restyle usage, task, login, and connection surfaces with solid light grays and thin neutral dividers.

**Step 2:** Restyle headings, metadata, status dots, buttons, and progress bars with a consistent neutral hierarchy.

**Step 3:** Preserve existing dimensions, overflow behavior, and all motion selectors.

### Task 3: Restyle the orb and verify

**Files:**
- Modify: `apps/desktop/src/styles.css`
- Verify: `test/widget-motion.test.ts`

**Step 1:** Replace the colored orb rings with a white base and two grayscale progress rings.

**Step 2:** Preserve collapsed shadow, expanded one-pixel border, pinned three-pixel border, and dragging state.

**Step 3:** Run `npm test -- test/widget-motion.test.ts`, `npm test`, and `npm run desktop:check`.

**Step 4:** Build the release app, restart it, and visually inspect the collapsed and expanded states.
