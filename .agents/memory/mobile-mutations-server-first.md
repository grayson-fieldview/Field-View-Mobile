---
name: Mobile mutations must be server-first, not local-only
description: Why local-state mutations in the Field View mobile app silently revert, and the required pattern
---

# Mobile mutations must hit the server before pruning local state

In the Field View Expo app, **projects and photos are cached locally** (AsyncStorage via `persistProjects`/`persistPhotos`) and the device re-syncs from the backend, merging server rows back in with `mergeById`. Tasks are server-only (in-memory).

**Trap (fixed 2026-05):** `DataContext.deleteProject` used to prune local arrays only and never call the API. The project vanished momentarily, then `mergeById` re-added the still-present server row on the next sync — looked like "delete does nothing / fails."

**Rule:** any destructive/mutating action on a locally-cached entity must `await api.<mutation>(...)` FIRST, and only prune+persist local state on success. On failure, let the `ApiError` propagate so the caller can surface it.

**Supporting facts (verify in code, may drift):**
- `apiFetch` (services/api.ts) already throws `ApiError(status, serverMessage, body)` on non-2xx — no per-call error wiring needed; callers just `.catch` and read `e.message` (carries server 403/409 messages).
- DELETE endpoints return 204; use `allowEmptyBody: true` (mirror `unshareProject`).
- Role gating is client-side UI only (`useAuth().role`, one of admin/manager/standard/restricted); authorization is server-enforced (surfaces as 403). Hide restricted-user affordances but never rely on the client gate for security.

**Why:** local-first optimism without a server call is invisible data loss/no-op masked by the sync layer.
