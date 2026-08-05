import { ApiError } from "@/services/api";
import { SocialAuthError } from "@/services/socialAuth";

/**
 * Map an OAuth sign-in failure to inline error copy. Branches on the
 * server's machine-readable error code (ApiError.body.error) first,
 * then on HTTP status, then falls back to the generic copy.
 */
export function oauthErrorMessage(e: unknown): string {
  if (e instanceof SocialAuthError) return e.message;
  if (e instanceof ApiError) {
    const code =
      e.body && typeof e.body === "object" && "error" in e.body
        ? (e.body as { error?: unknown }).error
        : undefined;
    if (
      code === "email_unverified_or_missing" ||
      code === "invite_email_mismatch" ||
      code === "account_deleted" ||
      code === "invite_invalid"
    ) {
      return e.message;
    }
    if (e.status === 401)
      return "We couldn't verify your sign-in. Please try again.";
    if (e.status === 503)
      return "Sign-in with Google isn't available right now. Please use your email and password.";
  }
  return "Sign in failed.";
}
