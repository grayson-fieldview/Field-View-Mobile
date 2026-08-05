/**
 * Native social sign-in flows (Sign in with Apple + Google Sign-In).
 *
 * This module's only job is to obtain an identity token from the
 * native SDKs. It never talks to our server and never touches
 * AuthContext — the login screen orchestrates: token from here →
 * AuthContext.signInWithApple/Google → server.
 *
 * Both flows return a SocialAuthResult so user-cancellation is a
 * distinguishable non-error outcome (the UI shows nothing for it).
 */
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import {
  GoogleSignin,
  isErrorWithCode,
  statusCodes,
} from "@react-native-google-signin/google-signin";
import { Platform } from "react-native";

export type SocialAuthResult =
  | {
      status: "success";
      idToken: string;
      /**
       * Apple only, and only on the FIRST authorization for that
       * Apple ID — null/absent every time after. Never an empty
       * string: empty/missing name parts are omitted entirely.
       */
      firstName?: string;
      lastName?: string;
    }
  | { status: "cancelled" };

/** A sign-in failure with copy safe to show in the login screen. */
export class SocialAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocialAuthError";
  }
}

// ---------------------------------------------------------------------------
// Apple (iOS only)
// ---------------------------------------------------------------------------

/**
 * Whether Sign in with Apple can be offered. Hard-gated on iOS —
 * expo-apple-authentication has no Android implementation, so
 * signInAsync must never run there.
 */
export async function isAppleSignInAvailable(): Promise<boolean> {
  if (Platform.OS !== "ios") return false;
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

export async function signInWithAppleNative(): Promise<SocialAuthResult> {
  // Nonce: random string, SHA256-hashed, hash passed to signInAsync so
  // Apple embeds it in the identity token. NOTE (reported finding):
  // the server's verifyAppleIdToken currently checks signature,
  // audience, and expiry only — it does NOT verify the nonce. We
  // generate it anyway so server-side verification can be added later
  // without a mobile release.
  const rawNonce = Crypto.randomUUID();
  const hashedNonce = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    rawNonce,
  );

  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });
  } catch (e) {
    if ((e as { code?: string } | null)?.code === "ERR_REQUEST_CANCELED") {
      return { status: "cancelled" };
    }
    throw e;
  }

  // identityToken is typed nullable; a null token on an otherwise
  // successful response is a distinct failure — never POST null.
  if (!credential.identityToken) {
    throw new SocialAuthError(
      "Apple didn't return a sign-in token. Please try again.",
    );
  }

  // fullName arrives only on the first-ever authorization. Pass name
  // parts through when non-empty; omit otherwise (never "").
  const givenName = credential.fullName?.givenName?.trim();
  const familyName = credential.fullName?.familyName?.trim();
  return {
    status: "success",
    idToken: credential.identityToken,
    ...(givenName ? { firstName: givenName } : {}),
    ...(familyName ? { lastName: familyName } : {}),
  };
}

// ---------------------------------------------------------------------------
// Google (iOS + Android)
// ---------------------------------------------------------------------------

// Configured lazily on first use (not at module load): configure() is
// synchronous and idempotent, and first-use keeps module import free
// of side effects on platforms/paths that never touch Google sign-in.
//
// Client IDs:
// - iosClientId → iOS: GIDSignIn's clientID, so the idToken aud on
//   iOS = the iOS client.
// - webClientId → Android: the native module calls
//   requestIdToken(webClientId), so the idToken aud on Android = this
//   dedicated web-type client. There is no androidClientId config key
//   in v16; the Android OAuth client is matched implicitly by package
//   name + SHA-1.
let googleConfigured = false;
function ensureGoogleConfigured(): void {
  if (googleConfigured) return;
  GoogleSignin.configure({
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
    iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  });
  googleConfigured = true;
}

export async function signInWithGoogleNative(): Promise<SocialAuthResult> {
  ensureGoogleConfigured();

  if (Platform.OS === "android") {
    try {
      await GoogleSignin.hasPlayServices({
        showPlayServicesUpdateDialog: true,
      });
    } catch (e) {
      if (isErrorWithCode(e) && e.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
        throw new SocialAuthError(
          "Google Play services isn't available on this device, so Google sign-in can't be used. Please sign in with your email and password.",
        );
      }
      throw e;
    }
  }

  try {
    const response = await GoogleSignin.signIn();
    // v16 envelope: { type: "success", data: User } | { type: "cancelled", data: null }
    if (response.type === "cancelled") return { status: "cancelled" };
    const idToken = response.data.idToken;
    if (!idToken) {
      throw new SocialAuthError(
        "Google didn't return a sign-in token. Please try again.",
      );
    }
    return { status: "success", idToken };
  } catch (e) {
    if (isErrorWithCode(e) && e.code === statusCodes.SIGN_IN_CANCELLED) {
      return { status: "cancelled" };
    }
    throw e;
  }
}

/**
 * Clear Google's cached account selection so the NEXT sign-in shows
 * the account picker instead of silently reusing the previous
 * account. Called from AuthContext.signOut. Never throws — sign-out
 * must always proceed.
 */
export async function signOutOfGoogle(): Promise<void> {
  try {
    ensureGoogleConfigured();
    await GoogleSignin.signOut();
  } catch {
    /* never block sign-out */
  }
}
