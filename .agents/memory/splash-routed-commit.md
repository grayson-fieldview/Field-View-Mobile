---
name: Splash hold waits for redirect commit
description: Cold-launch auth redirect vs splash-hide ordering in the mobile app's root layout
---

Rule: the `routed` flag (which gates the native splash hide) must flip only when the auth redirect has COMMITTED — i.e. when `segments` already reflect the `(auth)` group — not on the pass that issues `router.replace`.

**Why:** setting `routed` alongside the replace lifts the splash while the visible route is still `(tabs)` (navigation dispatched but not painted), producing a ~0.2s Projects flash on cold launch. Separately, gating/unmounting the navigator on `routed` (`if (!routed) return null`) was an earlier App-Store-rejection-adjacent bug: expo-router silently drops replaces issued before the navigator commits. Never reintroduce either.

**How to apply:** unauthenticated branch issues the replace and returns without setting `routed`; the segments change re-runs the effect and flips `routed` in-group. The authenticated branch deliberately keeps issue-time `routed` (splash already handled). A one-shot 5s fallback timer (marker `SPLASH_HIDE_FALLBACK_FIRED`, double-hide guarded by a ref) force-hides the splash if navigation never commits.
