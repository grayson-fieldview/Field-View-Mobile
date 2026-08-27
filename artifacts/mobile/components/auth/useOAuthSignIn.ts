import { useRouter } from "expo-router";
import { useState } from "react";

import { useAuth } from "@/contexts/AuthContext";
import {
  signInWithAppleNative,
  signInWithGoogleNative,
} from "@/services/socialAuth";
import { logMetaRegistrationCompleted } from "@/services/metaAttribution";

import { oauthErrorMessage } from "./oauthErrorMessage";

export type OAuthProvider = "apple" | "google";

/**
 * Owns the native OAuth sign-in flow shared by the auth screens:
 * per-provider in-flight state, the post-success lockout, and the
 * cancel/error handling.
 *
 * `isBlocked` is evaluated at press time and MUST be supplied by the
 * screen: each screen composes its own `anyInFlight` (login includes
 * its email/password `loading`; signup composes its own). Deriving
 * the guard in here would change login's disable behavior — keep it
 * screen-computed.
 */
export function useOAuthSignIn({
  setError,
  isBlocked,
  registrationFlow = false,
}: {
  setError: (msg: string | null) => void;
  isBlocked: () => boolean;
  registrationFlow?: boolean;
}) {
  const router = useRouter();
  const { signInWithApple, signInWithGoogle } = useAuth();
  // Which OAuth button is currently in flight (spinner on that one).
  const [oauthLoading, setOauthLoading] = useState<OAuthProvider | null>(null);
  // Once ANY sign-in succeeds, ALL buttons stay disabled — same
  // deliberate guard as login's primary-button non-re-enable
  // (the passport session-regenerate double-login bug).
  const [signedIn, setSignedIn] = useState(false);

  const handleOAuth = async (provider: OAuthProvider) => {
    if (isBlocked()) return;
    setError(null);
    setOauthLoading(provider);
    try {
      const result =
        provider === "apple"
          ? await signInWithAppleNative()
          : await signInWithGoogleNative();
      if (result.status === "cancelled") {
        // No error UI on cancellation — buttons simply re-enable.
        setOauthLoading(null);
        return;
      }
      // No inviteToken: there is no deep link handling in the app;
      // the server resolves pending invitations by verified email.
      if (provider === "apple") {
        await signInWithApple({
          idToken: result.idToken,
          firstName: result.firstName,
          lastName: result.lastName,
        });
      } else {
        await signInWithGoogle({ idToken: result.idToken });
      }
      if (registrationFlow) {
        logMetaRegistrationCompleted(provider);
      }
      setSignedIn(true); // keep everything disabled — see guard note
      router.replace("/(tabs)");
      setOauthLoading(null);
    } catch (e) {
      setError(oauthErrorMessage(e));
      setOauthLoading(null);
    }
  };

  return { oauthLoading, signedIn, handleOAuth };
}
