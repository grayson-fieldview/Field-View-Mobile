/**
 * Google Play Billing (via expo-iap) — purchase-submission helpers for
 * Android, mirroring services/appleIap.ts. Used by the app-wide
 * purchaseUpdatedListener in AuthContext (live purchases + replayed
 * unacknowledged purchases).
 *
 * Contract with the server (POST /api/billing/google/purchase): the
 * client sends { purchaseToken, productId } (`purchase.purchaseToken`
 * is expo-iap's unified token field — the Play purchaseToken on
 * Android); the server verifies with the Play Developer API, binds the
 * account, and returns the full serialized user.
 *
 * finishTransaction (= acknowledge on Android) is called after a
 * server 200, OR after a TERMINAL server rejection — same rationale as
 * the Apple flow: retrying a terminal rejection can never succeed, and
 * an unacknowledged purchase replays on every launch (and Play refunds
 * it after ~3 days if never acknowledged, which is exactly what we
 * want for purchases the server permanently refused). Retryable
 * failures (network, 5xx incl. 503 verification_unavailable, bare
 * 401s) stay unfinished so the replay retries.
 */
// Type-only import — erased at compile time. Runtime expo-iap is
// imported dynamically (same stale-dev-client rationale as appleIap).
import type { Purchase, SubscriptionOffer } from "expo-iap";

import { ApiError, api, normalizeUser, type BackendUser } from "./api";
import { logMetaSubscriptionPurchase } from "./metaAttribution";
import { Sentry } from "./sentry";

/**
 * Server errors that can NEVER succeed on retry. Identical 409 set to
 * Apple's, plus the coded-401 rule below. 503 verification_unavailable
 * is NOT here — it's the server saying "Play API is down, try later",
 * and the >=500 check keeps it retryable.
 */
const TERMINAL_PURCHASE_ERROR_CODES = new Set<string>([
  "transaction_bound_to_other_account",
  "account_bound_to_other_subscription",
  "stripe_subscription_active",
  "provider_conflict",
  "unknown_product",
]);

export function isTerminalGooglePurchaseError(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false; // transport → retryable
  if (e.status >= 500) return false; // incl. 503 verification_unavailable
  const body =
    e.body && typeof e.body === "object"
      ? (e.body as Record<string, unknown>)
      : {};
  const code = typeof body.error === "string" ? body.error : null;
  // Same 401 rule as Apple: a CODED 401 (verification_failed) means
  // the billing handler rejected this exact token — terminal. A BARE
  // 401 is the session/CSRF middleware and must stay retryable
  // (finishing on an auth blip would permanently discard a valid
  // purchase — confirmed prod incident on the Apple path).
  if (e.status === 401) return code != null;
  return code != null && TERMINAL_PURCHASE_ERROR_CODES.has(code);
}

/**
 * Distinct user-facing copy per server error case — Play-flavored
 * mirror of describeApplePurchaseError.
 */
export function describeGooglePurchaseError(e: unknown): string {
  if (e instanceof ApiError) {
    const body =
      e.body && typeof e.body === "object"
        ? (e.body as Record<string, unknown>)
        : {};
    const code = typeof body.error === "string" ? body.error : null;
    switch (code) {
      case "stripe_subscription_active":
        return "This account already has an active subscription managed on the web. Manage your plan at field-view.com — no Google Play purchase is needed.";
      case "account_bound_to_other_subscription":
        return "This account is already linked to a different Google Play subscription. Use the Google account that bought it, or contact support.";
      case "transaction_bound_to_other_account":
        return "This Google Play subscription is already linked to a different Field View account. Sign in to that account, or contact support to move it.";
      case "provider_conflict":
        return "This account's billing is managed elsewhere and can't accept a Google Play purchase. Contact support if this seems wrong.";
      case "unknown_product":
        return "Google Play reported a product this version of the app doesn't recognize. Please update Field View and try again.";
      case "verification_failed":
        // Terminal (coded 401): the purchase is finished, no retry is
        // coming.
        return "This purchase couldn't be verified with Google Play. If you were charged, contact support.";
      case "verification_unavailable":
        // Retryable 503 — the unacknowledged purchase replays.
        return "Google Play verification is temporarily unavailable. Your purchase is safe — it will be retried automatically on next launch.";
      case "no_account":
        return "We couldn't find an account to attach this purchase to. Sign in and try again.";
      default:
        if (e.status === 401) {
          return "The purchase couldn't be verified right now. Your purchase is safe — it will be retried automatically on next launch.";
        }
        return e.message || "The purchase couldn't be confirmed.";
    }
  }
  return e instanceof Error && e.message
    ? e.message
    : "The purchase couldn't be confirmed.";
}

/**
 * Pick the offerToken to purchase with, from expo-iap's normalized
 * `subscriptionOffers` (Play's raw subscriptionOfferDetails). Each
 * seat product has base plan "monthly" and offer "free-trial"; Play
 * only returns offers the user is ELIGIBLE for, so a returning user
 * may only get the base-plan entry (offerId null → `id` empty).
 *
 * Rule (PROVISIONAL until confirmed against a device log):
 *   1. the "free-trial" offer on the "monthly" base plan,
 *   2. else any offer on the "monthly" base plan with a token,
 *   3. else the first offer with a token.
 */
export function selectGooglePlayOfferToken(
  offers: SubscriptionOffer[] | null | undefined,
): string | null {
  const list = (offers ?? []).filter(
    (o) => typeof o.offerTokenAndroid === "string" && o.offerTokenAndroid,
  );
  const monthly = list.filter((o) => o.basePlanIdAndroid === "monthly");
  const pick =
    monthly.find((o) => o.id === "free-trial") ?? monthly[0] ?? list[0];
  return pick?.offerTokenAndroid ?? null;
}

/**
 * Token-free summary of an offer, safe to ship to Sentry. offerTokens
 * are deliberately EXCLUDED — they're purchase credentials.
 */
export type GooglePlayOfferSummary = {
  id: string;
  basePlanIdAndroid: string | null;
};

export function summarizeGooglePlayOffers(
  offers: SubscriptionOffer[] | null | undefined,
): GooglePlayOfferSummary[] {
  return (offers ?? []).map((o) => ({
    id: o.id ?? "",
    basePlanIdAndroid: o.basePlanIdAndroid ?? null,
  }));
}

/**
 * The offer-selection rule above is the one UNVALIDATED assumption in
 * the Android billing path (pending a device log). When it fails for a
 * product the user actually tried to buy, we need the offer shape in
 * Sentry — not just a silent alert — so the rule can be corrected.
 */
export function reportGooglePlayOfferSelectionFailure(
  productId: string,
  offers: GooglePlayOfferSummary[],
): void {
  Sentry.captureMessage("google play offer selection returned no token", {
    level: "error",
    tags: { source: "google_play_offer_selection" },
    extra: {
      productId,
      offerCount: offers.length,
      offers,
    },
  });
}

/**
 * In-flight registry — same at-most-once-per-process pattern as
 * appleIap. A separate Set is fine: the two platforms are mutually
 * exclusive at runtime, and keys (platform-native tokens) can't
 * collide meaningfully.
 */
const inFlightPurchases = new Set<string>();

function purchaseKey(purchase: Purchase): string {
  return purchase.id || purchase.purchaseToken || "";
}

/**
 * Submit one Play purchase to the server; finish (acknowledge) on 200
 * or on a TERMINAL rejection (finished, then rethrown). Returns the
 * normalized BackendUser (caller applies it), or null when this exact
 * purchase is already mid-flight elsewhere. Throws on failure —
 * RETRYABLE failures leave the purchase unacknowledged so it replays.
 */
export async function processGooglePlayPurchase(
  purchase: Purchase,
): Promise<BackendUser | null> {
  const token = purchase.purchaseToken;
  if (typeof token !== "string" || token.length === 0) {
    // No token — nothing the server could verify. Leave unfinished.
    throw new Error("Purchase is missing its Google Play token.");
  }
  const key = purchaseKey(purchase);
  if (inFlightPurchases.has(key)) return null;
  inFlightPurchases.add(key);
  try {
    return await submitAndFinish(purchase, token);
  } catch (e) {
    if (isTerminalGooglePurchaseError(e)) {
      // Best-effort — if finishTransaction itself hiccups, the next
      // replay hits the same terminal branch and finishes then.
      try {
        const { finishTransaction } = await import("expo-iap");
        await finishTransaction({ purchase, isConsumable: false });
      } catch {
        // swallow: replay is the retry mechanism for the finish itself
      }
    }
    throw e;
  } finally {
    inFlightPurchases.delete(key);
  }
}

async function submitAndFinish(
  purchase: Purchase,
  token: string,
): Promise<BackendUser> {
  const res = await api.submitGooglePurchase(token, purchase.productId);
  const me = normalizeUser(res);
  if (!me) {
    // 200 without a user body: treat as failure — do NOT finish, the
    // replay will retry once the server behaves.
    throw new Error(
      "The purchase was recorded but the account didn't refresh. It will retry on next launch.",
    );
  }
  // Server owns the entitlement now — safe to acknowledge. If THIS
  // call throws, the replay re-submits the same token; the server's
  // idempotent handling makes that harmless.
  const { finishTransaction } = await import("expo-iap");
  await finishTransaction({ purchase, isConsumable: false });
  // The server response is authoritative: Play may replay a purchase
  // after the request-time offer selection is gone from memory, while
  // subscriptionStatus still tells us whether the accepted entitlement
  // actually started in a trial.
  const status = me.subscriptionStatus?.toLowerCase();
  logMetaSubscriptionPurchase({
    productId: purchase.productId,
    isTrial: status === "trial" || status === "trialing",
  });
  return me;
}
