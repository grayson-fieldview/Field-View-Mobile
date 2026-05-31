---
name: Mobile task status is single-source enum
description: How mobile Field View tasks model status/done and the in_progress clobber trap
---

# Mobile task status model (Field View Expo app)

`Task.status` (`"todo" | "in_progress" | "done"`) is the SINGLE source of truth. `Task.done` is a **derived** convenience boolean (`done === (status === "done")`), recomputed by `mapBackendTask` and inside `updateTask`. There is NO independent stored `done` flag.

**Trap (fixed 2026-05):** the old `toggleTask` did `status === "done" ? "todo" : "done"`. Tapping an `in_progress` task jumped it straight to `done` — mobile could neither SET nor PRESERVE `in_progress`, silently diverging from web. Replaced with `cycleTaskStatus` (todo→in_progress→done→todo) to match web.

**Why:** web cycles 3 states; any binary done-toggle on mobile will re-introduce the clobber.
**How to apply:** status changes from mobile must go through the 3-state cycle (or set an explicit status), never a binary done flip. Status setting/filtering is client-side; backend filtering params are intentionally not used.
