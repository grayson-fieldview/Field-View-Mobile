---
name: Mobile OAuth contract (Apple/Google)
description: Wire contract and platform quirks for native Sign in with Apple / Google Sign-In on FieldView mobile
---
- Server endpoints `/api/auth/apple/mobile` and `/api/auth/google/mobile` return the FULL user object on 200 so mobile must set auth state directly from the POST body — **never** follow up with `me()`/settings fetches during sign-in: passport `req.login()` rotates the session id and a follow-up can race the jar's new Set-Cookie → spurious 401. `completeOAuthSignIn` in AuthContext fires zero authenticated requests by design (user-decided).
- Error branching uses `ApiError.body.error` codes: `email_unverified_or_missing`, `invite_email_mismatch`, `account_deleted`, `invite_invalid`; 401/503 get fixed copy. apiFetch already preserves the parsed non-2xx body in `ApiError.body` — no second error convention.
- Google v16 (`@react-native-google-signin/google-signin`): there is NO `androidClientId` config key. Android idToken is only issued when `webClientId` is configured (`requestIdToken(webClientId)`), so Android tokens have `aud` = the web client; iOS tokens have `aud` = `iosClientId`. FieldView uses a DEDICATED web-type client for the Android audience (…rdrvc21g…) — the live web login client (…bdkk…) must stay out of the server allowlist. Server allowlist holds iOS + Android + dedicated-web clients.
- Apple: nonce is generated (expo-crypto SHA256) and sent, but the server does NOT verify it yet — kept client-correct so server verification can land without a mobile release. fullName arrives only on first authorization; omit empty names, never send "".
- `AuthContext.signOut` calls `signOutOfGoogle()` LAST and fire-and-forget (not awaited, own .catch) — user decision: a hang in Google's native sign-out must never stall the logout chain. It only clears the account-picker cache; nothing depends on it.
- Login screen guard: after ANY successful sign-in (email or OAuth) all three buttons stay disabled — same passport session-regenerate double-login guard as the email button.
**Why:** hard-won session-rotation race + library-audience constraints; violating either silently breaks Android sign-in or produces spurious 401s.
**How to apply:** any change to mobile auth flows, Google client IDs, or the login screen.
