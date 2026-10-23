# Quota Urgency Highlight Design

## Goal

Make expiring, underused Codex quota visible without disrupting the redesigned monochrome orb. A quota window becomes urgent when it will reset within 30 minutes and at least 40% remains.

## Visual behavior

- The five-hour quota maps to the inner ring; the weekly quota maps to the outer ring.
- Only the urgent ring changes to a warm amber accent.
- The compact orb adds one soft amber halo with a 2.4-second breathing cycle when either window is urgent.
- The compact reset copy adopts the amber accent while the five-hour window is urgent.
- In the expanded panel, only the corresponding usage meter is accented and shows `即将恢复，建议用掉` alongside its reset countdown.
- If both windows are urgent, both rings and both meters are accented, but the orb still renders one breathing halo.
- With reduced-motion enabled, the halo remains visible but does not animate.

## State and timing

Urgency is derived in the desktop UI from `remainingPercent`, `resetsAt`, and a local clock. The clock advances once per minute so the UI can enter or leave the urgent state without waiting for the next bridge refresh.

Invalid, missing, stale, or already elapsed reset timestamps never produce urgency. The existing quota values and bridge protocol remain unchanged.

## Implementation boundaries

- Add a small pure urgency classifier beside the existing usage formatting helpers.
- Pass the derived urgency state to the orb and expanded usage meters through CSS classes and accessible labels.
- Reuse the current inner/outer conic-gradient structure; do not change window geometry, dragging, expansion, pinning, or quota refresh behavior.

## Verification

- Unit-test the 30-minute and 40% boundaries, elapsed timestamps, and missing data.
- Verify both individual rings and the combined state through rendered class names or equivalent component assertions.
- Run desktop TypeScript/Vite checks and the existing test suite.
- Inspect the rebuilt Tauri app in compact and expanded states, including reduced-motion CSS behavior.
