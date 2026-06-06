---
name: Android v1 location & onboarding model (Field View mobile)
description: Why Android has no background location/geofencing and how onboarding avoids an AuthGate loop
---

# Android v1: manual clock-in only

Android intentionally ships with NO background location, NO location foreground service, and NO geofencing. Only iOS does auto clock-in/out.

- `app.json`: `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION` are NOT in `android.permissions` and ARE listed in `android.blockedPermissions` (guard against transitive re-add by plugins). Keep `ACCESS_FINE/COARSE_LOCATION` for foreground/manual.
- `services/heartbeat.ts` `startHeartbeat()` early-returns on Android (and iOS, and web). The Android foreground-service location loop is the ONLY thing that block would have powered; FGS is used nowhere else (verified).
- `services/geofencing.ts` `registerGeofences()` already hard-guards `Platform.OS !== "ios"` and `defineTask` is iOS-only. Geofencing is iOS's auto path; Android has none.
- Places API key is platform-split: Android reads `EXPO_PUBLIC_GOOGLE_PLACES_API_KEY_ANDROID`, iOS reads `EXPO_PUBLIC_GOOGLE_PLACES_API_KEY` (distinct app-restricted Google Cloud keys). Separate from the package-id header split (X-Android-Package = com.fieldview.mobile vs X-Ios-Bundle-Identifier = com.fieldview.app).

**Why:** background location + FGS trigger sensitive Play review and a SecurityException at runtime if requested without the (now-removed) permissions. iOS bundle id stays `com.fieldview.app`; Android package was renamed to `com.fieldview.mobile`.

# Onboarding asymmetric-flag loop (do not reintroduce)

`app/(onboarding)/location.tsx` must never leave onboarding without burning BOTH `locationOnboardingFlags` `preprompted` AND `upgradeShown`. `preprompted` is AuthGate's gate; if it's left false after routing into the app, AuthGate bounces back to onboarding ("hang"). The single exit `exitToApp()` burns both (and pushes to AuthGate's in-memory listeners). Android skips the `alwaysUpgrade` phase entirely (it's the iOS Always-permission step), so it must still reach `notifications` → `exitToApp`. Every Android phase path routes through `exitToApp`, so symmetry holds.
**How to apply:** any new onboarding exit/branch must go through `exitToApp` (or set both flags) — never set `preprompted` alone.
