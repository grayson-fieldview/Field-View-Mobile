import {
  api,
  type CreditsResponse,
  type InsufficientAiCreditsBody,
} from "@/services/api";

type CreditsListener = (credits: CreditsResponse) => void;

let cachedCredits: CreditsResponse | null = null;
const listeners = new Set<CreditsListener>();

/** Credits available to a billable AI generation request. */
export function totalAiCredits(credits: CreditsResponse): number {
  return Math.max(
    0,
    (Number.isFinite(credits.monthly_remaining)
      ? credits.monthly_remaining
      : 0) +
      (Number.isFinite(credits.purchased_remaining)
        ? credits.purchased_remaining
        : 0),
  );
}

/** Latest successfully fetched credits; null until the first response. */
export function getCachedAiCredits(): CreditsResponse | null {
  return cachedCredits;
}

/** Listen for successful credits-query refreshes. */
export function subscribeToAiCredits(listener: CreditsListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Fetch and publish the current credit balance. Errors intentionally bubble:
 * callers decide whether they need to block an irreversible action (such as
 * recording a walkthrough) or can simply leave the displayed balance stale.
 */
export async function refreshAiCredits(): Promise<CreditsResponse> {
  const credits = await api.getCredits();
  cachedCredits = credits;
  for (const listener of listeners) listener(credits);
  return credits;
}

/** User-facing local date for a server-provided reset timestamp. */
export function formatCreditsResetDate(nextResetAt: string): string {
  const date = new Date(nextResetAt);
  if (!Number.isFinite(date.getTime())) return nextResetAt;
  return date.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** Exact copy used for both a zero balance and a 402 credit response. */
export function outOfCreditsMessage(nextResetAt: string): string {
  return `Out of credits — resets on ${formatCreditsResetDate(nextResetAt)}.`;
}

/** Kept as a named helper for consumers handling the 402 response body. */
export function outOfCreditsMessageFromBody(
  body: InsufficientAiCreditsBody,
): string {
  return outOfCreditsMessage(body.next_reset_at);
}
