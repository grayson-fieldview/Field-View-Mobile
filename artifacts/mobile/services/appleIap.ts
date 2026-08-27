/**
 * Apple IAP (StoreKit 2 via expo-iap) — shared purchase-submission
 * helpers used by BOTH the app-wide purchaseUpdatedListener in
 * AuthContext (live purchases + replayed unfinished transactions) and
 * the Restore Purchases flow on the choose-plan screen.
 *
 * Contract with the server (POST /api/billing/apple/purchase):
 * the client sends the raw JWS (`purchase.purchaseToken` — expo-iap's
 * unified token field IS the StoreKit 2 JWS on iOS); the server
 * verifies against its pinned Apple root, binds the account keyed on
 * originalTransactionId, and returns the full serialized user.
 *
 * finishTransaction is called after a server 200, OR after a TERMINAL
 * server rejection (see TERMINAL_PURCHASE_ERROR_CODES) — retrying a
 * terminal rejection can never succeed, and leaving it unfinished made
 * StoreKit replay it on every launch forever. Retryable failures
 * (network, 5xx, unrecognized) are left unfinished so StoreKit replays
 * — that replay is the retry mechanism; do not "helpfully" finish
 * retryable failures.
 */
// Type-only import — erased at compile time. The runtime expo-iap
// module is imported DYNAMICALLY inside submitAndFinish: this file is
// (transitively) imported by app/_layout.tsx for the skip flag, and a
// static runtime import here would crash a dev client that predates
// the expo-iap native module at bundle evaluation.
import { Alert } from "react-native";

import type { Purchase } from "expo-iap";

import { ApiError, api, normalizeUser, type BackendUser } from "./api";
import { logMetaSubscriptionPurchase } from "./metaAttribution";

/** Product IDs are fieldview.seats.3 … fieldview.seats.10. */
export const SEAT_PRODUCT_PREFIX = "fieldview.seats.";
export const MIN_SEATS = 3;
export const MAX_SEATS = 10;

export function seatProductId(seats: number): string {
  return `${SEAT_PRODUCT_PREFIX}${seats}`;
}

export const ALL_SEAT_PRODUCT_IDS: string[] = Array.from(
  { length: MAX_SEATS - MIN_SEATS + 1 },
  (_, i) => seatProductId(MIN_SEATS + i),
);

/**
 * Per-session "Skip this step" flag — module-level on purpose,
 * mirroring web's sessionStorage approach: survives re-renders and
 * remounts, resets on every cold launch. Gate 4's AuthGate will read
 * hasSkippedPlanThisSession() when routing to the paywall.
 */
let skippedPlanThisSession = false;

export function markPlanSkippedThisSession(): void {
  skippedPlanThisSession = true;
}

export function hasSkippedPlanThisSession(): boolean {
  return skippedPlanThisSession;
}

/**
 * Server errors that can NEVER succeed on retry, no matter how many
 * times StoreKit replays the transaction. For these the transaction
 * must be finished anyway — otherwise it replays on every launch
 * forever (confirmed in prod: 409 transaction_bound_to_other_account
 * replaying across launches). Everything else — network/transport,
 * 5xx, unrecognized codes — stays unfinished so the replay retries.
 */
const TERMINAL_PURCHASE_ERROR_CODES = new Set<string>([
  "transaction_bound_to_other_account",
  "account_bound_to_other_subscription",
  "stripe_subscription_active",
  "provider_conflict",
  "unknown_product",
]);

export function isTerminalApplePurchaseError(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false; // transport → retryable
  if (e.status >= 500) return false; // server fault → retryable
  const body =
    e.body && typeof e.body === "object"
      ? (e.body as Record<string, unknown>)
      : {};
  const code = typeof body.error === "string" ? body.error : null;
  // 401 with a structured error code = the billing handler rejected
  // the JWS itself; re-sending the same receipt can't verify
  // differently. A BARE 401 (no error code) is NOT terminal: the
  // session/CSRF middleware also answers 401 (confirmed prod incident
  // where ALL mobile requests 401'd), and finishing on that would
  // permanently discard a valid transaction over an auth blip.
  if (e.status === 401) return code != null;
  return code != null && TERMINAL_PURCHASE_ERROR_CODES.has(code);
}

/**
 * Distinct user-facing copy per server error case — never a generic
 * failure for a known 409. Falls back to the ApiError message (which
 * apiFetch already fills from the server body) for anything unknown.
 */
export function describeApplePurchaseError(e: unknown): string {
  if (e instanceof ApiError) {
    const body =
      e.body && typeof e.body === "object"
        ? (e.body as Record<string, unknown>)
        : {};
    const code = typeof body.error === "string" ? body.error : null;
    switch (code) {
      case "stripe_subscription_active":
        return "This account already has an active subscription managed on the web. Manage your plan at field-view.com — no App Store purchase is needed.";
      case "account_bound_to_other_subscription":
        return "This account is already linked to a different App Store subscription. Restore purchases from the Apple ID that bought it, or contact support.";
      case "transaction_bound_to_other_account":
        return "This App Store subscription is already linked to a different Field View account. Sign in to that account, or contact support to move it.";
      case "provider_conflict":
        return "This account's billing is managed elsewhere and can't accept an App Store purchase. Contact support if this seems wrong.";
      case "unknown_product":
        return "Apple reported a product this version of the app doesn't recognize. Please update Field View and try again.";
      case "verification_failed":
        // Terminal (coded 401): the transaction is finished, no retry
        // is coming — the old "retried on next launch" copy is wrong
        // for this case.
        return "This purchase couldn't be verified with Apple. If you were charged, contact support.";
      case "no_account":
        return "We couldn't find an account to attach this purchase to. Sign in and try again.";
      default:
        if (e.status === 401) {
          return "Apple's purchase receipt didn't verify. Your purchase is safe — it will be retried automatically on next launch.";
        }
        return e.message || "The purchase couldn't be confirmed.";
    }
  }
  return e instanceof Error && e.message
    ? e.message
    : "The purchase couldn't be confirmed.";
}

/**
 * Shared in-flight registry — covers BOTH the app-wide
 * purchaseUpdatedListener and the Restore flow, which can race on the
 * same unfinished transaction (a replay firing during a restore).
 * Keyed by transaction id, falling back to the JWS. `null` return
 * from processApplePurchase means "already being processed" — the
 * caller should do nothing (the winning caller applies the user).
 */
const inFlightPurchases = new Set<string>();

function purchaseKey(purchase: Purchase): string {
  return purchase.id || purchase.purchaseToken || "";
}

/**
 * Submit one purchase to the server; finish the transaction on 200 or
 * on a TERMINAL rejection (which is also finished, then rethrown, to
 * stop the forever-replay loop). Returns the normalized BackendUser
 * from the response (caller applies it via applyUpdatedUser), or null
 * when this exact transaction is already mid-flight elsewhere. Throws
 * on any failure — RETRYABLE failures leave the transaction unfinished
 * so StoreKit replays it.
 */
export async function processApplePurchase(
  purchase: Purchase,
): Promise<BackendUser | null> {
  const jws = purchase.purchaseToken;
  if (typeof jws !== "string" || jws.length === 0) {
    // No token — nothing the server could verify. Leave unfinished.
    throw new Error("Purchase is missing its App Store token.");
  }
  const key = purchaseKey(purchase);
  if (inFlightPurchases.has(key)) return null;
  inFlightPurchases.add(key);
  try {
    return await submitAndFinish(purchase, jws);
  } catch (e) {
    if (isTerminalApplePurchaseError(e)) {
      // Terminal server rejection: retrying the same transaction can
      // never succeed, so finish it to stop the forever-replay loop.
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
  jws: string,
): Promise<BackendUser> {
  const res = await api.submitApplePurchase(jws);
  const me = normalizeUser(res);
  if (!me) {
    // 200 without a user body: treat as failure — do NOT finish, the
    // replay will retry once the server behaves.
    throw new Error(
      "The purchase was recorded but the account didn't refresh. It will retry on next launch.",
    );
  }
  // Server owns the entitlement now — safe to finish. If THIS call
  // throws (StoreKit hiccup), the replay re-submits the same JWS; the
  // server's double-charge guard makes that harmless.
  const { finishTransaction } = await import("expo-iap");
  await finishTransaction({ purchase, isConsumable: false });
  // User decision: iOS seat products do not encode trial vs paid, so
  // every accepted Apple purchase is currently a Subscribe event.
  logMetaSubscriptionPurchase({
    productId: purchase.productId,
    isTrial: false,
  });
  return me;
}

/**
 * Shared Restore Purchases flow — used by the choose-plan paywall AND
 * the Settings screen (Apple expects restore reachable from a stable
 * location; a reinstalling subscriber never sees the paywall).
 *
 * getAvailablePurchases → filter to our seat SKUs →
 * processApplePurchase for each. Owns ALL user-facing feedback
 * (restored / nothing to restore / error alerts) so every entry point
 * behaves identically; callers only manage their own busy state.
 *
 * `applyUpdatedUser` matches AuthContext's signature; a `null` from
 * processApplePurchase means the app-wide listener already owns that
 * transaction (replay racing the restore) — counted as handled.
 */
export async function restoreApplePurchases(
  applyUpdatedUser: (raw: unknown) => void,
): Promise<void> {
  try {
    const iap = await import("expo-iap");
    const purchases = await iap.getAvailablePurchases();
    const ours = (purchases ?? []).filter((p) =>
      ALL_SEAT_PRODUCT_IDS.includes(p.productId),
    );
    if (ours.length === 0) {
      Alert.alert(
        "Nothing to restore",
        "No Field View subscription was found on this Apple ID.",
      );
      return;
    }
    let restored = 0;
    let lastError: unknown = null;
    for (const p of ours) {
      try {
        const me = await processApplePurchase(p);
        if (me) applyUpdatedUser(me);
        restored += 1;
      } catch (e) {
        lastError = e;
      }
    }
    if (restored > 0) {
      Alert.alert(
        "Purchases restored",
        "Your subscription is active on this account.",
      );
    } else if (lastError) {
      // Same case-specific copy as the purchase path — never generic.
      Alert.alert("Restore failed", describeApplePurchaseError(lastError));
    }
  } catch (e) {
    Alert.alert("Restore failed", describeApplePurchaseError(e));
  }
}
