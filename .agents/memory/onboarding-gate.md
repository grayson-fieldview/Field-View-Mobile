---
name: Onboarding gate & profileCompletedAt defaults
description: How mobile onboarding routing works and the two deliberately different missing-field defaults
---

- AuthGate's authenticated branch is the ONLY navigation source for the onboarding gate: `profileCompletedAt == null` → replace to `/(auth)/onboarding-profile`, same commit-then-flip routed/splash pattern; navigator never gated.
- **Two deliberately different defaults — never unify:** fresh SERVER response with `profileCompletedAt` null/missing ⇒ needs onboarding (mirrors web's falsy check). Keychain snapshot with the key ABSENT ⇒ completed (sentinel `legacy-snapshot-assumed-complete`) so pre-release users booting offline are never trapped in onboarding.
- **Why:** offline cold boots restore from cached snapshots that predate the field; treating absence as incomplete would strand existing users on onboarding with no server reachable.
- Onboarding submit does NOT call refreshUser (a follow-up me() races the reverify in-flight lock and can silently no-op). PATCH /api/auth/me returns the full updated user; `applyUpdatedUser(raw)` applies it directly (toAuthUser → setUser → verified → persist snapshot, ZERO network). It refuses when userRef is null — sign-out during the in-flight PATCH nulls the user, so this equals the epoch check.
- Submit order: PATCH /api/account/name (admin + name entered, failure stops all) → PATCH /api/auth/me (unselected optionals OMITTED, never null/"") → applyUpdatedUser(response) → replace("/(tabs)"). PATCH /api/auth/me does NOT rotate the session id (only req.login does).
- Non-admin (`role !== "admin"`, null = non-admin) hides Company Name, industry, company size — server silently discards admin-only fields, so showing them would eat input.
