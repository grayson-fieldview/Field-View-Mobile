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
 * finishTransaction is called ONLY after a server 200. On any error
 * the transaction is left unfinished so StoreKit replays it on next
 * launch — that replay is the retry mechanism; do not "helpfully"
 * finish failed transactions.
 */
import { finishTransaction, type Purchase } from "expo-iap";

import { ApiError, api, normalizeUser, type BackendUser } from "./api";

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
 * Submit one purchase to the server; finish the transaction ONLY on
 * 200. Returns the normalized BackendUser from the response (caller
 * applies it via applyUpdatedUser), or null when this exact
 * transaction is already mid-flight elsewhere. Throws on any failure
 * — with the transaction deliberately left unfinished so it replays.
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
  await finishTransaction({ purchase, isConsumable: false });
  return me;
}
