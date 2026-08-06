import { ApiError } from "@/services/api";

/**
 * Map an email-signup failure to inline error copy. Sibling of
 * oauthErrorMessage (same structure: branch on the server's
 * machine-readable ApiError.body.error code first, then fall back to
 * generic copy) — a separate helper because the signup endpoint's
 * code set and copy decisions differ from OAuth's, and mixing both
 * into one function would couple two independently-evolving flows.
 */
export function signupErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const code =
      e.body && typeof e.body === "object" && "error" in e.body
        ? (e.body as { error?: unknown }).error
        : undefined;
    if (code === "email_exists") {
      return "An account with that email already exists. Try logging in instead.";
    }
    if (code === "too_many_requests" || e.status === 429) {
      return "Too many sign-up attempts. Please try again in an hour.";
    }
    if (
      code === "password_too_short" ||
      code === "invite_invalid" ||
      code === "invite_email_mismatch" ||
      code === "terms_not_accepted" ||
      code === "missing_credentials"
    ) {
      // Server copy is user-appropriate for these.
      return e.message;
    }
  }
  return "Sign up failed. Please try again.";
}
