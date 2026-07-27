---
name: Session cookie guard on error responses
description: Why non-2xx Set-Cookie handling must be sid-aware, not status-aware
---

The backend runs express-session with `rolling: true` (live since April 2026, Postgres-backed store, 14-day sliding window): EVERY authenticated response — including 4xx — re-sends the SAME `connect.sid` value with a pushed-out Expires.

**Rule:** the mobile cookie jar must persist a Set-Cookie from a non-2xx response when its cookie value(s) exactly match the jar (rolling refresh), and discard only when the value DIFFERS (fresh anonymous sid that would clobber the authenticated session).

**Why:** a blanket "discard Set-Cookie on non-2xx" guard silently starved sessions of sliding-window refreshes — enough 4xx traffic and a daily-active user's cookie aged out server-side → confirmed-401 → logout (TestFlight build 39 repeated-logout bug).

**How to apply:** any change to cookie ingestion in the mobile API layer must keep the sid-match comparison, not revert to status-only gating. Sentry event "Set-Cookie discarded on error response" now carries `sidMatch:false` + `jarSize`; sid values themselves are never logged.
