---
name: Session cookie handling (mobile jar)
description: Current status of Set-Cookie gating, serialized Keychain writes, and login double-fire — history of the build 39-41 logout bugs
---

**Current state (build 41 / v1.1.5, July 2026, user-directed):** cookie ingestion is back to status-only gating — only 2xx responses write to the jar. The sid-match guard (persist same-sid rolling refreshes on 4xx) and a short-lived login-family exemption were REVERTED at the user's explicit request after a session-minting histogram showed the differing-sid guard correlated with tripled server-side session minting. Discards on non-2xx still emit a Sentry breadcrumb with `sidMatch` + `jarSize`.

**Known tradeoff accepted by the user:** the backend runs express-session `rolling: true` (14-day sliding window) and re-sends the SAME `connect.sid` on 4xx; discarding those refreshes was the build-39 starvation-logout theory. If 14-day-expiry logouts resurface, sid-match persistence is the candidate fix — but do not re-add it without the user's sign-off.

**Root cause actually found (build 40 "logged out on next launch"):** double POST /api/login ~6s apart — second login carried the first's sid, passport `regenerate()` destroyed it. Two mobile bugs fixed in build 41:
1. Keychain jar writes were fire-and-forget and UNORDERED — memory could end at live sid B while Keychain kept destroyed sid A, resurrected on cold start. All jar writes now go through a serialized promise chain (`queueJarWrite`), and `clearSession` chains its removal behind pending writes (else a late write resurrects a signed-out session).
2. The login button re-armed in `finally` after a 200 while navigation was still committing — a second tap there sends login #2 carrying the fresh sid. Button now stays disabled on success.

**How to apply:** never add a raw `secureStorage.setItem(COOKIE_STORAGE_KEY, …)` outside the write chain; never re-enable the login button before the screen unmounts; any future Set-Cookie gating change needs the user's explicit approval (this area has flip-flopped twice with production consequences).
