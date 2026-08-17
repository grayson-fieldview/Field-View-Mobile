import { Platform } from "react-native";
import { Sentry } from "./sentry";
import { secureStorage } from "./secureStorage";
import type { CanonicalStroke, StoredStroke } from "./types";

/**
 * API client for the Field View web backend.
 *
 * Base URL is configured via EXPO_PUBLIC_API_BASE_URL (set in .env at
 * the artifact root). This lets us swap to the Vercel app.field-view.com
 * deployment by flipping one env var.
 *
 * Auth: session cookies (express-session on the backend). On native
 * platforms we parse Set-Cookie from login responses, persist
 * the cookie jar in expo-secure-store (Keychain), and attach it as the
 * Cookie header on every subsequent request. On web we rely on
 * credentials: "include" and the browser's native cookie jar.
 */

export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/+$/, "") ?? "";

console.log("[api] API_BASE_URL =", API_BASE_URL);

const COOKIE_STORAGE_KEY = "fv_session_cookies";

// Cookie jar keyed by cookie name so a new value for the same name
// REPLACES the prior one (e.g. a rotated connect.sid). Storing as a
// Map prevents the "connect.sid=A; connect.sid=B" duplication bug.
const cookieJar: Map<string, string> = new Map();
let loaded = false;
/**
 * Serialized jar as last written to (or read from) the Keychain — used
 * by parseAndPersistSetCookie to skip byte-identical rewrites (rolling
 * refreshes carry the same value on every response, including 4xx).
 */
let lastPersistedJar: string | null = null;

// Attributes that should NOT be stored as cookies — these are cookie
// metadata (Path, Expires, etc.), not name/value pairs.
const COOKIE_ATTR_RE =
  /^(path|expires|httponly|max-age|domain|samesite|secure)$/i;

/** Serialize the jar to a single Cookie header value. */
function serializeCookieJar(): string {
  const out: string[] = [];
  for (const [name, value] of cookieJar) out.push(`${name}=${value}`);
  return out.join("; ");
}

/**
 * Parse a "name=value; name2=value2" Cookie-header-style string into
 * the in-memory jar. Used by loadSession() to migrate previously
 * persisted jars (which may contain duplicate entries from the bug
 * this fix addresses) — last occurrence wins.
 */
function ingestSerializedJar(raw: string): void {
  const re = /([\w.!#$%&'*+\-^`|~]+)=([^;,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1];
    if (COOKIE_ATTR_RE.test(name)) continue;
    cookieJar.set(name, m[2]);
  }
}

/**
 * Diagnostic snapshot of the in-memory cookie jar. Returns names and
 * truncated values (first 12 chars). Safe to log — never reveals the
 * full session signature. Used by AuthContext.bootstrap() to trace
 * the cold-start auth flow.
 */
export function debugCookieSnapshot(): {
  size: number;
  names: string[];
  preview: string;
} {
  const names: string[] = [];
  const parts: string[] = [];
  for (const [name, value] of cookieJar) {
    names.push(name);
    parts.push(`${name}=${value.slice(0, 12)}…(len=${value.length})`);
  }
  return { size: cookieJar.size, names, preview: parts.join("; ") };
}

/** Load the persisted cookie jar into memory (call once on app start). */
export async function loadSession(): Promise<string | null> {
  console.log("[boot] loadSession starting");
  if (loaded) {
    console.log(
      "[boot] loadSession already-loaded, jar size =",
      cookieJar.size,
    );
    return cookieJar.size ? serializeCookieJar() : null;
  }
  loaded = true;
  const raw = await secureStorage.getItem(COOKIE_STORAGE_KEY);
  if (raw == null) {
    console.log("[boot] keychain read fv_session_cookies = MISSING");
  } else {
    console.log(
      `[boot] keychain read fv_session_cookies = PRESENT (len=${raw.length})`,
    );
  }
  console.log(
    "[cookie-migration] loaded from storage:",
    raw ? `(len=${raw.length})` : "(empty)",
  );
  if (!raw) {
    console.log("[cookie-migration] after dedup: (empty)");
    console.log("[cookie-migration] differs:", false);
    console.log("[boot] cookieJar size = 0, names = []");
    return null;
  }

  // One-time migration: dedupe any duplicate cookie names that the
  // previous append-style logic may have written. Last value wins.
  cookieJar.clear();
  ingestSerializedJar(raw);
  const cleaned = serializeCookieJar();
  console.log("[cookie-migration] after dedup:", `(len=${cleaned.length})`);
  console.log("[cookie-migration] differs:", raw !== cleaned);
  const snap = debugCookieSnapshot();
  console.log(
    `[boot] cookieJar size = ${snap.size}, names = [${snap.names.join(", ")}]`,
  );
  if (cleaned !== raw) {
    queueJarWrite(cleaned);
  }
  lastPersistedJar = cleaned;
  return cleaned || null;
}

/** Clear the in-memory and on-disk cookie jar. */
export async function clearSession(): Promise<void> {
  cookieJar.clear();
  loaded = true;
  lastPersistedJar = null;
  // Chain the removal behind any pending jar writes: a queued persist
  // completing AFTER this removeItem would resurrect the cleared
  // session in the Keychain (sign-out that un-signs-out on relaunch).
  jarWriteChain = jarWriteChain.then(() =>
    secureStorage.removeItem(COOKIE_STORAGE_KEY),
  );
  await jarWriteChain;
}

export function hasSession(): boolean {
  return cookieJar.size > 0;
}

/**
 * Does an incoming Set-Cookie header carry EXACTLY the session the jar
 * already holds? True iff it contains at least one cookie pair and every
 * pair matches an existing jar entry by name AND value.
 *
 * Why: express-session runs with `rolling: true` (server-side, live since
 * 2026-04), so every authenticated response — including 4xx — re-sends
 * the SAME `connect.sid` value with a pushed-out Expires to extend the
 * 14-day sliding window. Those refreshes are safe to persist regardless
 * of status code (the value is identical; only metadata changed). A
 * DIFFERENT value on an error response is the real hazard the non-2xx
 * guard was built for: a fresh anonymous sid that would clobber the
 * authenticated session in the jar + Keychain.
 */
function setCookieMatchesJar(raw: string): boolean {
  const re = /([\w.!#$%&'*+\-^`|~]+)=([^;,]*)/g;
  let m: RegExpExecArray | null;
  let pairs = 0;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1];
    if (COOKIE_ATTR_RE.test(name)) continue;
    pairs += 1;
    if (cookieJar.get(name) !== m[2]) return false;
  }
  return pairs > 0;
}

/**
 * Serialization chain for Keychain jar writes. The persists are
 * intentionally not awaited by request handling (fire-and-forget), but
 * they MUST land in issue order: two close-together writes (sid A from
 * login #1, sid B from login #2) completing out of order leave the
 * Keychain holding a destroyed sid while memory holds the live one —
 * works all session, then 401s from the next cold start when
 * loadSession resurrects the stale sid.
 */
let jarWriteChain: Promise<void> = Promise.resolve();

function queueJarWrite(serialized: string): void {
  jarWriteChain = jarWriteChain.then(async () => {
    try {
      await secureStorage.setItem(COOKIE_STORAGE_KEY, serialized);
      console.log(`[login] keychain write = SUCCESS (len=${serialized.length})`);
    } catch (e) {
      // secureStorage.setItem is non-throwing by design (it captures to
      // Sentry internally), so this is belt-and-braces: a failed jar
      // write means silent logout on next cold start — be loud.
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[login] keychain write = FAILED: ${msg}`);
      Sentry.captureMessage("session jar Keychain write failed", {
        level: "error",
        extra: { serializedLen: serialized.length },
      });
    }
  });
}

function parseAndPersistSetCookie(raw: string | null): void {
  if (!raw) return;
  // Parse all `name=value` pairs out of the combined set-cookie header,
  // ignoring cookie attributes and the commas inside Expires dates.
  // Within a single Set-Cookie response, last value wins for a given
  // name (matches what a real browser would store after applying each
  // Set-Cookie in order).
  const re = /([\w.!#$%&'*+\-^`|~]+)=([^;,]*)/g;
  let m: RegExpExecArray | null;
  let updated = false;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1];
    if (COOKIE_ATTR_RE.test(name)) continue;
    cookieJar.set(name, m[2]); // overwrite any existing entry
    updated = true;
  }
  if (!updated) return;
  const serialized = serializeCookieJar();
  // Skip the Keychain write when the jar is byte-identical to what we
  // last persisted. Rolling-session refreshes (same sid, new Expires —
  // now ingested even on 4xx) hit this constantly; only metadata changed,
  // so there is nothing new to store. Keeps Keychain write volume at
  // "on actual cookie change" instead of "on every 4xx".
  if (serialized === lastPersistedJar) return;
  lastPersistedJar = serialized;
  queueJarWrite(serialized);
}

/**
 * Sentry breadcrumb for every ApiError throw. Deliberately limited to
 * method + path + status — NEVER request bodies, NEVER cookie values.
 */
function breadcrumbApiError(method: string, path: string, status: number): void {
  Sentry.addBreadcrumb({
    category: "api",
    level: "error",
    message: `ApiError ${status} ${method} ${path}`,
    data: { method, path, status },
  });
}

/**
 * TEMP DIAG (build 41): breadcrumb EVERY api response — method, path,
 * status, and whether the request carried a session cookie. Sentry
 * attaches the trailing breadcrumbs to any captured event, so the
 * confirmed-401 logout event in AuthContext arrives with the exact
 * request sequence (last ~100) that preceded it. Never bodies, never
 * cookie values.
 */
function breadcrumbApiResponse(
  method: string,
  path: string,
  status: number,
  hadCookie: boolean,
): void {
  Sentry.addBreadcrumb({
    category: "api",
    level: status >= 400 ? "warning" : "info",
    message: `${status} ${method} ${path}${hadCookie ? "" : " (no cookie)"}`,
    data: { method, path, status, hadCookie },
  });
}

/**
 * TEMP DIAG (build 41): sanitized shape of a raw Set-Cookie header —
 * to check whether RN's fetch comma-concatenates multiple cookies and
 * whether the parser could mis-split. Reports structure only: header
 * length, comma count, cookie names (attribute names excluded), how
 * many times each name repeats, and per-value lengths. NEVER values.
 */
function breadcrumbSetCookieShape(raw: string, path: string): void {
  try {
    const re = /([\w.!#$%&'*+\-^`|~]+)=([^;,]*)/g;
    let m: RegExpExecArray | null;
    const names: string[] = [];
    const valueLens: number[] = [];
    while ((m = re.exec(raw)) !== null) {
      if (COOKIE_ATTR_RE.test(m[1])) continue;
      names.push(m[1]);
      valueLens.push(m[2].length);
    }
    Sentry.addBreadcrumb({
      category: "session",
      level: "info",
      message: "Set-Cookie shape",
      data: {
        path,
        headerLen: raw.length,
        commas: (raw.match(/,/g) ?? []).length,
        names,
        valueLens,
      },
    });
  } catch {
    /* diagnostics must never break the request */
  }
}

// ---- 402 Payment Required notification --------------------------------
// The server 402s write endpoints when the account's accessLevel is
// read_only/locked. apiFetch notifies these listeners BEFORE throwing —
// the throw itself is unchanged, so every existing catch site
// (rollbacks, upload-queue retry classification, mutate-server-first
// pruning) behaves identically. One subscriber lives in AuthContext
// and shows a single debounced user-facing message.

type PaymentRequiredListener = (info: { path: string; message: string }) => void;

const paymentRequiredListeners = new Set<PaymentRequiredListener>();

/** Subscribe to 402 responses. Returns an unsubscribe function. */
export function onPaymentRequired(
  listener: PaymentRequiredListener,
): () => void {
  paymentRequiredListeners.add(listener);
  return () => paymentRequiredListeners.delete(listener);
}

function notifyPaymentRequired(path: string, message: string): void {
  for (const l of paymentRequiredListeners) {
    try {
      l({ path, message });
    } catch {
      // A listener must never break the request error path.
    }
  }
}

/** Narrowing helper: true when `e` is an ApiError with status 402. */
export function isPaymentRequired(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status === 402;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface FetchOpts {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  json?: unknown;
  headers?: Record<string, string>;
  /** If true, treat an HTML response as "unauthenticated" (returns null) instead of throwing. */
  allowHtmlAsUnauth?: boolean;
  /**
   * If true, a 204 No Content response (or any 2xx with
   * `Content-Length: 0`) resolves to `undefined` instead of
   * throwing the default "Unexpected non-JSON response" error.
   *
   * Use for fire-and-forget DELETE / state-change endpoints whose
   * server contract intentionally omits a body. Do NOT enable for
   * endpoints that are expected to return data — silent
   * `undefined` would mask a server-side regression.
   *
   * Use for endpoints that return 204 (e.g. push-token
   * unregister) where a body is intentionally absent.
   */
  allowEmptyBody?: boolean;
  /**
   * Abort the request after this many ms. RN fetch has NO default
   * timeout (requests hang until the OS gives up) — leave unset for
   * normal calls. Set explicitly for known-slow SYNCHRONOUS endpoints
   * (e.g. AI report generation) so a hung connection eventually
   * surfaces as an error instead of spinning forever. On abort the
   * request throws ApiError(0, "Request timed out ...").
   */
  timeoutMs?: number;
}

async function apiFetch<T>(path: string, opts: FetchOpts = {}): Promise<T> {
  if (!API_BASE_URL) {
    throw new ApiError(
      0,
      "EXPO_PUBLIC_API_BASE_URL is not configured. Check artifacts/mobile/.env.",
    );
  }
  if (!loaded) await loadSession();

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(opts.headers ?? {}),
  };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  // On web the browser manages cookies via credentials: "include".
  // On native we must attach the Cookie header ourselves.
  if (cookieJar.size > 0 && Platform.OS !== "web") {
    headers["Cookie"] = serializeCookieJar();
  }
  // CSRF defense: the web backend's CSRF middleware allows mobile
  // requests through on presence of this custom header. RN's native
  // fetch can't reliably set Origin, so the Origin allowlist used
  // for web isn't usable here — X-FieldView-Client is the only
  // deterministic mobile-identity signal.
  //
  // Attach on EVERY request (not just non-GETs) so the server's CSRF
  // middleware can match the mobile bypass on reads as well as
  // writes. Without this on GETs, /api/auth/user can 401 in
  // CSRF-enforce mode even with a valid session cookie, and
  // refreshUser then misreads it as "logged out" and yanks the user
  // (root cause of the TestFlight Build 6 instant-logout bug).
  // Header value is versioned so future deprecations don't brick
  // older mobile builds.
  const method = opts.method ?? "GET";
  if (Platform.OS === "ios" || Platform.OS === "android") {
    headers["X-FieldView-Client"] = "mobile-1";
  }
  // Never log raw cookie values — length + presence only.
  console.log(
    "[cookie-outgoing]",
    headers["Cookie"] ? `(present, len=${headers["Cookie"].length})` : "(none)",
  );

  // Path-aware tagged tracing for the two auth endpoints we're
  // diagnosing (cold-start instant-logout investigation). These
  // tags let us grep a single trace out of Metro / Sentry breadcrumb
  // logs: `[boot]` for cold-start me(), `[login]` for sign-in.
  const traceTag =
    path === "/api/auth/user"
      ? "[boot]"
      : path === "/api/login"
        ? "[login]"
        : null;
  if (traceTag === "[boot]") {
    console.log("[boot] me() about to fetch");
    console.log(
      `[boot] me() Cookie header being sent = ${headers["Cookie"] ? "yes" : "no"} (len=${(headers["Cookie"] ?? "").length})`,
    );
    console.log(
      "[boot] me() X-FieldView-Client header =",
      headers["X-FieldView-Client"] ?? "(MISSING)",
    );
  }

  let res: Response;
  const timeoutController = opts.timeoutMs ? new AbortController() : null;
  let timedOut = false;
  const timeoutHandle =
    timeoutController && opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          timeoutController.abort();
        }, opts.timeoutMs)
      : null;
  try {
    console.log("[api] →", opts.method ?? "GET", API_BASE_URL + path);
    console.log(
      "[api] Cookie being sent:",
      headers["Cookie"] ? `(present, len=${headers["Cookie"].length})` : "(none)",
    );
    res = await fetch(`${API_BASE_URL}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body,
      credentials: Platform.OS === "web" ? "include" : "omit",
      signal: timeoutController?.signal,
    });
    console.log("[api] ←", res.status, path);
    breadcrumbApiResponse(
      opts.method ?? "GET",
      path,
      res.status,
      !!headers["Cookie"],
    );
    const setCookieHeader = res.headers.get("set-cookie");
    if (setCookieHeader) breadcrumbSetCookieShape(setCookieHeader, path);
    if (setCookieHeader)
      console.log(
        "[api] Set-Cookie received:",
        `(present, len=${setCookieHeader.length})`,
      );
    if (traceTag === "[boot]") {
      console.log("[boot] me() response status =", res.status);
      console.log(
        "[boot] me() response Set-Cookie present =",
        setCookieHeader ? "yes" : "no",
      );
    }
    if (traceTag === "[login]") {
      console.log(
        `[login] response Set-Cookie = ${setCookieHeader ? `(present, len=${setCookieHeader.length})` : "(none)"}`,
      );
      // Peek the jar AFTER parseAndPersistSetCookie runs below.
      // We can't snapshot here (parsing happens after this block);
      // see the snapshot just past the `parseAndPersistSetCookie`
      // call.
    }
  } catch (e) {
    breadcrumbApiError(opts.method ?? "GET", path, 0);
    if (timedOut) {
      throw new ApiError(
        0,
        `Request timed out after ${opts.timeoutMs}ms: ${path}`,
      );
    }
    throw new ApiError(
      0,
      `Network request failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  // Capture any new/rotated session cookies — but ONLY from success
  // responses. A 401/403/5xx must never be allowed to overwrite the
  // authenticated cookie: if the server attaches a fresh anonymous
  // session cookie to an error response (e.g. express-session
  // re-issuing a sid on an unauthenticated request), ingesting it
  // would silently clobber the good session in the jar + Keychain
  // and log the user out on the next foreground refresh.
  //
  // Logout does NOT rely on this path — signOut() calls
  // clearSession() explicitly, which wipes the jar and Keychain.
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    // REVERTED (build 41): back to pre-guard, status-only gating — only
    // 2xx responses may write to the jar. The differing-sid guard and
    // the login-family exemption are removed while the real session
    // killer is isolated; breadcrumbs below keep the discard visible.
    // KNOWN TRADEOFF: same-sid rolling refreshes on 4xx are discarded
    // again (the build-39 sliding-window starvation concern).
    if (res.ok) {
      parseAndPersistSetCookie(setCookie);
    } else {
      const sidMatch = setCookieMatchesJar(setCookie);
      console.warn(
        `[api] DISCARDED Set-Cookie on non-2xx: ${opts.method ?? "GET"} ${path} status=${res.status} sidMatch=${sidMatch}`,
      );
      Sentry.addBreadcrumb({
        category: "session",
        level: "warning",
        message: "Set-Cookie discarded on non-2xx response",
        data: {
          method: opts.method ?? "GET",
          path,
          status: res.status,
          sidMatch,
          jarSize: cookieJar.size,
        },
      });
    }
  }
  if (traceTag === "[login]") {
    const snap = debugCookieSnapshot();
    console.log(
      `[login] cookieJar after parse: size=${snap.size}, ${snap.preview || "(empty)"}`,
    );
  }

  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  // Empty-body short-circuit MUST run before the !isJson check —
  // 204 responses commonly omit Content-Type entirely, which would
  // otherwise trip the "Unexpected non-JSON response" guard. Only
  // honored on the success path; error responses (4xx/5xx) still
  // run the message-extraction logic below.
  const contentLength = res.headers.get("content-length");
  const isEmptyBody = res.status === 204 || contentLength === "0";

  if (!res.ok) {
    let parsed: unknown = null;
    let message = `Request failed (${res.status})`;
    try {
      if (isJson) {
        parsed = await res.json();
        if (
          parsed &&
          typeof parsed === "object" &&
          "message" in parsed &&
          typeof (parsed as { message: unknown }).message === "string"
        ) {
          message = (parsed as { message: string }).message;
        }
      } else {
        parsed = await res.text();
      }
    } catch {
      /* ignore */
    }
    if (res.status === 402) {
      // Readable fallback when the server body carried no message —
      // never the bare "Request failed (402)".
      if (message === `Request failed (${res.status})`) {
        message =
          "Your account is read-only. An admin needs to update billing to make changes.";
      }
      // Notify BEFORE throwing; throw semantics below are unchanged.
      notifyPaymentRequired(path, message);
    }
    breadcrumbApiError(opts.method ?? "GET", path, res.status);
    throw new ApiError(res.status, message, parsed);
  }

  if (opts.allowEmptyBody && isEmptyBody) {
    return undefined as T;
  }

  if (!isJson) {
    if (opts.allowHtmlAsUnauth) {
      // Treat HTML (SPA fallback) as "not authenticated".
      return null as T;
    }
    const text = await res.text().catch(() => "");
    breadcrumbApiError(opts.method ?? "GET", path, res.status);
    throw new ApiError(
      res.status,
      "Unexpected non-JSON response from API — the endpoint may not exist or you may be logged out.",
      text.slice(0, 300),
    );
  }

  return (await res.json()) as T;
}

// ----- Types returned by the backend -----
export type UserRole = "admin" | "manager" | "standard" | "restricted";

export interface BackendUser {
  id: string | number;
  email: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  /** Owner flag from /api/auth/user (web backend, deployed 2026-04-28). */
  isOwner?: boolean;
  /**
   * Account role (web backend Team rework, 2026-05). Used to gate the
   * "Add team member" button (admin-only) and to hide admin-only
   * surfaces from non-admins. Optional because pre-rework user rows
   * may not yet carry the field; absent → treated as non-admin.
   */
  role?: UserRole;
  /** Avatar URL from /api/users (account-wide user list). Optional/null. */
  profileImageUrl?: string | null;
  /**
   * ISO-8601 timestamp stamped by the server on the first successful
   * PATCH /api/auth/me. Present on GET /api/auth/user and both mobile
   * OAuth responses. null (or absent) on a fresh SERVER response means
   * the user has not completed onboarding.
   */
  profileCompletedAt?: string | null;
  /**
   * Email verification flag (web backend, 2026-08). Optional like
   * profileCompletedAt — pre-rollout responses/snapshots may omit it.
   * Named emailVerified deliberately: "verified"/"unverified" are
   * reserved for AuthContext's SESSION re-verification vocabulary.
   */
  emailVerified?: boolean;
  /**
   * Account billing access level, overlaid on every auth response by
   * the server (overlayAccountBillingOnUser). Optional like
   * emailVerified — pre-rollout responses/snapshots may omit it, and
   * absent must never be treated as restricted.
   */
  accessLevel?: "full" | "read_only" | "locked";
  /**
   * Account billing subscription status, overlaid on auth responses
   * alongside accessLevel. Optional like emailVerified — pre-rollout
   * responses/snapshots may omit it; absent must never gate. Loose
   * string on purpose: Stripe/Apple statuses evolve (trialing, trial,
   * active, past_due, canceled, …) and unknown values must pass
   * through rather than be dropped.
   */
  subscriptionStatus?: string;
  /**
   * ISO-8601 timestamp set once by POST /api/account/skip-paywall
   * (owner+admin only), overlaid on every auth response. Optional like
   * the other overlays — BUT the gating rule is inverted: absent means
   * NOT skipped (paywall shows). A missing field must never
   * permanently hide the paywall.
   */
  accountPaywallSkippedAt?: string | null;
  /**
   * Soft-delete marker from /api/users. Non-null means the user has been
   * deactivated and should be filtered out of any "pick a teammate" UI.
   */
  deletedAt?: string | null;
  [key: string]: unknown;
}

/**
 * Read-only account billing summary (GET /api/account/billing-summary,
 * admin-only). Display-only on mobile — no manage/upgrade affordances.
 *
 * `status` raw values observed: "trialing" | "active" | "past_due" |
 * "canceled" — typed as string so an unknown future status renders
 * (title-cased) instead of failing.
 * `trialEndsAt` is an ISO-8601 timestamp, null when not trialing.
 * `billingProvider` is NOT reliable in current prod config — never
 * branch UI on it.
 */
export interface BillingSummary {
  accountName: string;
  status: string;
  trialEndsAt: string | null;
  billingProvider: string;
  seats: { used: number; total: number };
  activeProjects: number;
  photoCount: number;
}

/**
 * Pending team invitation. Server creates the row in /api/invitations and
 * sends the invite email; the row stays `status: "pending"` until the
 * recipient accepts (becoming a real user) or the row is cancelled.
 *
 * `assignedProjectIds` is only meaningful when role === "restricted" —
 * the server scopes the future user's project visibility to this list.
 * For other roles the array is ignored / not sent.
 */
export interface BackendInvitation {
  id: string | number;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  token: string;
  status: "pending" | "accepted" | "cancelled" | "expired";
  expiresAt: string;
  createdAt: string;
  accountId: string;
  invitedById: string;
}

/**
 * One row of the per-project team list returned by
 * /api/projects/:id/assignments. Joins the assignment record with the
 * user fields needed to render a member row (avatar, name, email,
 * role badge) without a second round-trip.
 */
export interface BackendProjectAssignment {
  id: string | number;
  userId: string;
  projectId: number | string;
  firstName: string;
  lastName: string;
  email: string;
  avatarUrl?: string | null;
  role: UserRole;
}

export interface BackendProject {
  id: number | string;
  name: string;
  description?: string | null;
  status?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  color?: string | null;
  tags?: string[] | null;
  coverPhotoId?: number | null;
  accountId?: string;
  createdById?: string;
  createdAt: string;
  updatedAt: string;
  photoCount?: number;
  recentPhotos?: Array<{ id: number; url: string }>;
}

export interface BackendMedia {
  id: number | string;
  projectId: number | string;
  filename?: string;
  originalName?: string;
  mimeType?: string;
  url: string;
  /** CloudFront-delivered ~400px rendition. Null on a handful of legacy
   *  rows — always render `thumbUrl ?? url` in grids. */
  thumbUrl?: string | null;
  caption?: string | null;
  /**
   * AI-generated caption (server-side vision pass). DISTINCT from
   * `caption` (the user-authored one). May be the internal sentinel
   * string "UNCLEAR" — renderers must never display that value.
   */
  aiCaption?: string | null;
  /** Client-reported capture time; null when never sent or rejected
   *  server-side. Fall back to createdAt when absent. */
  takenAt?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  tags?: string[] | null;
  createdAt: string;
  /**
   * Uploading user (additive server field). ABSENT when the uploader was
   * deleted; may be present with null names.
   */
  uploader?: {
    id: string;
    firstName: string | null;
    lastName: string | null;
  };
}

/**
 * One annotation row from the media_annotations table — one per user per
 * media. `strokes` is the canonical wire array (normalized 0..1 points,
 * width in 1000-units). Typed as StoredStroke[] so the tolerant render
 * path can also accept any legacy-shaped strokes the server might return.
 */
export interface BackendAnnotationRow {
  id: string | number;
  mediaId: string | number;
  userId: string | number;
  strokes: StoredStroke[];
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Reverse-lookup of where a single media row is referenced. Returned by
 * GET /api/media/:id/references and consumed by the photo-delete flow
 * to warn the user when deleting will also strip a photo from reports
 * or checklists (and, for shared reports, break the public share link).
 *
 * Server-side note: restricted users only see rows they can otherwise
 * read; mobile does NOT try to compensate. `tasks` is always [] per the
 * current server contract — typed for parity, ignored by callers.
 */
export interface MediaReferences {
  reports: Array<{ id: number | string; title: string; isShared: boolean }>;
  checklists: Array<{ id: number | string; title: string }>;
  tasks: Array<{ id: number | string }>;
}

/**
 * Build the user-facing "this photo is in X" sentence for the delete
 * dialog. Returns "" when there are no references — callers should
 * fall back to the generic "This will permanently remove the photo."
 * copy in that case (handled by the photo-delete confirm path).
 *
 * Grammar contract (singular/plural, reports-first when mixed):
 *   1 report          → "1 report"
 *   N reports         → "N reports"
 *   1 checklist       → "1 checklist"
 *   N checklists      → "N checklists"
 *   N reports + M checklists → "N reports and M checklists"
 *
 * Appends a shared-report warning if ANY referenced report has an
 * active share token.
 */
export function buildMediaReferencesMessage(refs: MediaReferences): string {
  const r = refs.reports.length;
  const c = refs.checklists.length;
  if (r === 0 && c === 0) return "";
  const reportPart = r > 0 ? `${r} report${r === 1 ? "" : "s"}` : "";
  const checklistPart =
    c > 0 ? `${c} checklist${c === 1 ? "" : "s"}` : "";
  const places =
    r > 0 && c > 0
      ? `${reportPart} and ${checklistPart}`
      : reportPart || checklistPart;
  // Singular vs plural location count: "from there" reads naturally for
  // a single location, "from those places" for two or more. Avoids the
  // "in 1 report. … from those places" grammar bug.
  const fromWhere = r + c === 1 ? "there" : "those places";
  const sharedWarning = refs.reports.some((rep) => rep.isShared)
    ? "\n\nThis is a shared report — deleting will break the shared link."
    : "";
  return `This photo is in ${places}. Deleting will remove it from ${fromWhere} too. Are you sure?${sharedWarning}`;
}

/** Task status enum — mirrors the postgres `tasks.status` enum exactly. */
export type BackendTaskStatus = "todo" | "in_progress" | "done";

/** Task priority enum — mirrors the postgres `tasks.priority` enum exactly. */
export type BackendTaskPriority = "low" | "medium" | "high";

export interface BackendTask {
  id: number | string;
  projectId: number | string;
  title: string;
  description?: string | null;
  status?: BackendTaskStatus | null;
  priority?: BackendTaskPriority | null;
  /** Single nullable FK to users.id. Server name is `assignedToId`. */
  assignedToId?: string | null;
  /** User id of the creator. Server-stamped on POST; never accepted from clients. */
  createdById?: string | null;
  /**
   * Server-joined display fields for the assignee. Present on GET
   * responses; may or may not be present on POST/PATCH responses
   * depending on backend serializer. Mappers fall back to the
   * optimistic display name passed by the picker when this is absent.
   */
  assignedTo?: {
    id?: string;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
  } | null;
  dueDate?: string | null;
  /**
   * Task photo requirement (task_photos join). Both are present on task
   * list payloads; treated as optional defensively since POST/PATCH
   * serializers may omit computed fields.
   */
  requiredPhotoCount?: number | null;
  attachedPhotoCount?: number | null;
  createdAt: string;
  updatedAt?: string;
  project?: { name?: string };
}

// ----- Checklists v2 (field-MVP, 2026-05) -----
//
// Read-mostly mobile surface over the server's checklist schema. Mobile
// can read templates + instances and write item values / notes / photo
// attachments. Authoring NEW instances / items / templates is web-only —
// mobile can only "apply template" to spawn an instance from an existing
// template. All field names are camelCase to match the wire format the
// rest of api.ts already assumes.

export type ChecklistFieldType =
  | "yes_no"
  | "rating"
  | "text"
  | "multiple_choice";

export interface BackendChecklist {
  id: number | string;
  projectId: number | string;
  title: string;
  /** Source template if this instance was applied from one (null for ad-hoc). */
  templateId?: number | string | null;
  templateTitle?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface BackendChecklistSection {
  id: number | string;
  checklistId: number | string;
  title: string;
  sortOrder: number;
}

export interface BackendChecklistItem {
  id: number | string;
  checklistId: number | string;
  /** May be null for items not grouped into a section. */
  sectionId?: number | string | null;
  label: string;
  fieldType: ChecklistFieldType;
  sortOrder: number;
  /** Server-side hint that the field is required to "complete" the item. */
  required?: boolean;
  /** Number of photos required before the item is considered complete (0 = none). */
  photosRequired?: number;
  /** Optional helper text rendered under the label. */
  helpText?: string | null;
  // ----- value fields (only the one matching fieldType is meaningful) -----
  valueBool?: boolean | null;
  valueRating?: number | null;
  valueText?: string | null;
  selectedOptionId?: number | null;
  notes?: string | null;
  /** Server-stamped when the item transitions to "has value". */
  completedAt?: string | null;
  /** Optional per-item assignee. */
  assignedToUserId?: string | null;
}

export interface BackendChecklistItemOption {
  id: number | string;
  itemId: number | string;
  label: string;
  sortOrder: number;
}

export interface BackendChecklistItemPhoto {
  /** Junction row id — pass to detachPhotoFromItem. */
  id: number | string;
  itemId: number | string;
  mediaId: number;
  /** Convenience copy from the joined media row, for immediate render. */
  url: string;
  createdAt?: string;
}

export interface BackendChecklistTemplate {
  id: number | string;
  title: string;
  description?: string | null;
  /** Optional short tag (e.g. "Punch list", "Site walk"). */
  category?: string | null;
  /** Counts so the picker can preview without a second round-trip. */
  sectionCount?: number;
  itemCount?: number;
  createdAt: string;
}

export interface BackendProjectDetail {
  project: BackendProject;
  media?: BackendMedia[];
  tasks?: BackendTask[];
  checklists?: unknown[];
  reports?: BackendReport[];
}

// ----- Project files (read-only, 2026-08) -----
//
// GET /api/projects/:id/files. `displayName` is nullable and the server
// never collapses it into `originalName` — render `displayName ??
// originalName` everywhere a name is shown. `url` is a public unsigned
// CloudFront URL (same as photo URLs): fetchable with no auth headers;
// only the list call needs the authenticated client.

export interface BackendProjectFile {
  id: number | string;
  projectId: number | string;
  uploadedById: number | string;
  filename: string;
  originalName: string;
  displayName: string | null;
  mimeType: string;
  url: string;
  sizeBytes: number | null;
  createdAt: string;
  uploadedByName: string;
}

/** Per-item request for POST /api/uploads/sign when uploading project
 *  files (folder: "files"). Distinct from the photo sign flow, which
 *  omits `folder`. */
export interface SignFileUploadItem {
  originalName: string;
  mimeType: string;
  fileSize: number;
  folder: "files";
}

/** Per-item response for the files sign flow. `contentDisposition` is
 *  BAKED INTO the PUT signature — the S3 PUT must send it verbatim as
 *  the Content-Disposition header or S3 rejects with a signature
 *  mismatch. Never reconstruct it. */
export interface SignFileUploadResponse {
  key: string;
  uploadUrl: string;
  publicUrl: string;
  contentDisposition: string;
}

/** Per-item body for POST /api/projects/:id/files. `key` and
 *  `publicUrl` must be sent EXACTLY as returned by the sign endpoint —
 *  the server validates publicUrl === getS3Url(key) and 400s on
 *  mismatch. */
export interface RegisterProjectFileItem {
  key: string;
  publicUrl: string;
  originalName: string;
  mimeType: string;
  fileSize: number;
}

// ----- Reports (Mobile Reports R1, 2026-05) -----
//
// Read + write surface for the report builder. Mobile can list, create
// (blank or from template), edit metadata, author sections, attach +
// detach project photos, edit photo captions, and trigger server-side
// PDF generation. Template AUTHORING is web-only — mobile only picks
// from existing report_templates rows. All field names are camelCase
// to match the wire format.

export type ReportStatus =
  | "draft"
  | "submitted"
  | "approved"
  // Walkthrough pipeline (2026-08): the server now creates the report
  // row up-front, so a report can be observed mid-generation or after
  // a failed generation.
  | "generating"
  | "failed";

/**
 * Report types accepted by POST /api/projects/:id/reports/generate
 * (`reportType` is required). Exact mirror of the server source
 * (server/lib/aiReports.ts) — any other value 400s.
 */
export const REPORT_TYPES = [
  "client_update",
  "daily_log",
  "progress_recap",
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

/** Human labels for the picker — match web's dialog exactly. */
export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  client_update: "Client Update",
  daily_log: "Daily Log",
  progress_recap: "Progress Recap",
};

export interface BackendReport {
  id: number | string;
  projectId: number | string;
  accountId: number | string;
  title: string;
  description?: string | null;
  /** Free-form jsonb cover-page config (logo, branding, etc.). */
  coverConfig?: unknown;
  status: ReportStatus;
  /** Public share-link token (web-only feature for R1; surfaced for read). */
  shareToken?: string | null;
  createdById: number | string;
  createdAt: string;
  updatedAt?: string;
}

export interface BackendReportSection {
  id: number | string;
  reportId: number | string;
  title: string;
  summary?: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt?: string;
}

/**
 * A task_photos join row from GET /api/tasks/:id/photos. The list
 * endpoint nests the joined media row (with a presigned `url`) under
 * `media`; POST responses may omit it (same tolerance as checklist /
 * report section photo rows).
 */
export interface BackendTaskPhoto {
  /** Junction row id — pass to detachTaskPhoto. */
  id: number | string;
  taskId?: number | string;
  mediaId: number;
  sortOrder?: number;
  createdAt?: string;
  media?: {
    id?: number;
    url?: string;
    originalName?: string | null;
    mimeType?: string;
  };
}

export interface BackendReportSectionPhoto {
  /** Junction row id — pass to detachSectionPhoto / updateSectionPhoto. */
  id: number | string;
  sectionId: number | string;
  mediaId: number;
  caption?: string | null;
  description?: string | null;
  sortOrder: number;
  createdAt?: string;
  /**
   * Convenience copy of the joined media row's URL for immediate render.
   * Some server responses inline the URL at the top level; others nest
   * it under `media`. Both shapes are tolerated by readers.
   */
  url?: string;
  media?: {
    id: number;
    s3Key?: string;
    url?: string;
  };
}

export interface BackendReportTemplate {
  id: number | string;
  accountId: number | string;
  title: string;
  /**
   * The full template structure (sections + items) lives inside this
   * jsonb blob — there is no separate report_template_sections table.
   * Server validates the shape via templateConfigSchema; mobile parses
   * `templateConfig.sections.length` for the picker preview.
   */
  templateConfig: unknown;
  /** Optional pre-computed section count (saves a parse on the picker). */
  sectionCount?: number;
  createdById: number | string;
  createdAt: string;
  updatedAt?: string;
}

/** Full-tree response from GET /api/reports/:id. */
export type BackendReportTreeResponse = BackendReport & {
  sections: Array<
    BackendReportSection & { photos: BackendReportSectionPhoto[] }
  >;
};

// ----- Photo upload (3-step presigned-URL flow) -----

export interface SignUploadFile {
  originalName: string;
  mimeType: string;
  fileSize: number;
}

export interface SignUploadResponse {
  key: string;
  uploadUrl: string;
  publicUrl: string;
}

export interface CreateMediaFile {
  key: string;
  publicUrl: string;
  originalName: string;
  mimeType: string;
  latitude?: number;
  longitude?: number;
  /**
   * Capture time, strict ISO 8601 datetime (the server regex rejects
   * bare dates / locale formats). Omit entirely when unknown — never
   * send null or "". Malformed/out-of-range values are stored as null
   * server-side and never fail the upload.
   */
  takenAt?: string;
}

export type CreateMediaResponse = BackendMedia;

/**
 * Thrown by `api.uploadToS3` when the presigned URL has expired (S3 returns
 * HTTP 403 with `SignatureDoesNotMatch` in the response body). Callers should
 * re-request a fresh signed URL via `api.signUploads` and retry the PUT.
 */
export class UploadExpiredError extends Error {
  constructor(message = "Upload URL expired (S3 SignatureDoesNotMatch)") {
    super(message);
    this.name = "UploadExpiredError";
  }
}

export interface DeleteUserResponse {
  success: boolean;
  deletedAt?: string;
  restoreDeadline?: string;
}

export interface DeleteAccountResponse {
  success: boolean;
  deletedAt?: string;
  restoreDeadline?: string;
  message?: string;
}

/**
 * Response from POST /api/projects/:id/share. Server mints (or
 * returns the existing) public share token for the project. The
 * recipient-facing URL is `https://app.field-view.com/p/<token>`.
 */
export interface BackendShareTokenResponse {
  shareToken: string;
}

/**
 * Response from POST /api/galleries. Server creates a NEW shared
 * gallery row scoped to the given mediaIds (every POST mints a fresh
 * token; old links keep working; no expiry). Recipient-facing URL is
 * `https://app.field-view.com/gallery/<token>`.
 */
export interface BackendSharedGalleryResponse {
  token: string;
  id?: number | string;
  projectId?: number;
  createdAt?: string;
}

/**
 * A media comment row from GET/POST /api/media/:id/comments.
 * `user` is optional: the list join omits it for deleted authors, and
 * the POST response never includes it.
 */
export interface BackendCommentResponse {
  id: number;
  mediaId: number;
  userId: string | null;
  content: string;
  createdAt: string;
  user?: {
    firstName: string | null;
    lastName: string | null;
    profileImageUrl: string | null;
  };
}

// ----- Endpoint wrappers -----
export const api = {
  base: API_BASE_URL,

  login: (email: string, password: string) =>
    apiFetch<BackendUser | { user: BackendUser } | null>("/api/login", {
      method: "POST",
      json: { email, password },
    }),

  /**
   * Native Sign in with Apple. POSTs the Apple identity token; the
   * server verifies it, creates the account if needed (implicit
   * signup), calls req.login(), and returns the FULL user object
   * shaped exactly like GET /api/auth/user — so no follow-up me()
   * is required (or safe: passport rotates the session id, and a
   * follow-up can race the new Set-Cookie landing in the jar).
   *
   * Optional fields are OMITTED when null/undefined/empty rather
   * than sent as explicit nulls — the server treats absence and
   * null identically for all three, and empty-string names must
   * never be sent (Apple only provides fullName on the first
   * authorization; absence means "not available this time").
   *
   * Non-2xx throws ApiError with `body` = the server's parsed
   * { error?, message } JSON, so callers can branch on the
   * machine-readable `error` code (email_unverified_or_missing,
   * invite_email_mismatch, account_deleted, invite_invalid).
   */
  loginWithApple: (args: {
    idToken: string;
    inviteToken?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  }) => {
    const json: Record<string, string> = { idToken: args.idToken };
    if (args.inviteToken) json.inviteToken = args.inviteToken;
    if (args.firstName) json.firstName = args.firstName;
    if (args.lastName) json.lastName = args.lastName;
    return apiFetch<BackendUser | { user: BackendUser } | null>(
      "/api/auth/apple/mobile",
      { method: "POST", json },
    );
  },

  /** Native Google Sign-In. Same contract as loginWithApple. */
  loginWithGoogle: (args: { idToken: string; inviteToken?: string | null }) => {
    const json: Record<string, string> = { idToken: args.idToken };
    if (args.inviteToken) json.inviteToken = args.inviteToken;
    return apiFetch<BackendUser | { user: BackendUser } | null>(
      "/api/auth/google/mobile",
      { method: "POST", json },
    );
  },

  /**
   * Mobile email/password registration. Same contract as the mobile
   * OAuth endpoints: 201 returns the FULL user (session cookie set by
   * req.login()), errors are { error, message } with machine-readable
   * codes (terms_not_accepted, missing_credentials, password_too_short,
   * email_exists, invite_invalid, invite_email_mismatch,
   * registration_failed, too_many_requests).
   */
  registerMobile: (args: {
    email: string;
    password: string;
    termsAccepted: boolean;
    inviteToken?: string | null;
  }) => {
    const json: Record<string, string | boolean> = {
      email: args.email,
      password: args.password,
      termsAccepted: args.termsAccepted,
    };
    if (args.inviteToken) json.inviteToken = args.inviteToken;
    return apiFetch<BackendUser | { user: BackendUser } | null>(
      "/api/auth/register/mobile",
      { method: "POST", json },
    );
  },

  /**
   * Submit the 6-digit email verification code. 200 returns the FULL
   * updated user (also 200 if already verified) — apply it via
   * applyUpdatedUser, no follow-up me(). Non-2xx throws ApiError with
   * `body` = { error, ... } for branching:
   *   401 invalid_code       (body.remaining_attempts: number)
   *   410 no_active_code | code_expired
   *   429 too_many_attempts  (code invalidated — must resend)
   */
  verifyEmailCode: (email: string, code: string) =>
    apiFetch<BackendUser | { user: BackendUser } | null>(
      "/api/verify-email-code",
      { method: "POST", json: { email, code } },
    ),

  /**
   * Persist the paywall skip (owner+admin only, body-less, set-once).
   * Returns the full serialized user with accountPaywallSkippedAt
   * stamped — same union as verifyEmailCode; callers normalize via
   * normalizeUser and apply with applyUpdatedUser.
   */
  skipPaywall: () =>
    apiFetch<BackendUser | { user: BackendUser } | null>(
      "/api/account/skip-paywall",
      { method: "POST" },
    ),

  /**
   * Request a fresh verification code. 60s per-user cooldown server-
   * side: 429 throws ApiError with body.retry_after_seconds. Response
   * is generic if already verified (enumeration-safe).
   */
  resendVerification: (email: string) =>
    apiFetch<unknown>("/api/resend-verification", {
      method: "POST",
      json: { email },
    }),

  /**
   * Submit an Apple IAP purchase (StoreKit 2 JWS) for server-side
   * verification and account binding. Returns the FULL serialized
   * user on 200 — apply via applyUpdatedUser, no follow-up me().
   *
   * Error contract (ApiError; token in body.error):
   *   401 verification failed (JWS didn't verify against Apple's chain)
   *   400 unknown_product | no_account
   *   409 stripe_subscription_active
   *       | account_bound_to_other_subscription
   *       | transaction_bound_to_other_account
   *       | provider_conflict
   *
   * Callers must finishTransaction ONLY after this resolves — an
   * unfinished transaction replays on next launch, which is the
   * at-least-once retry mechanism for server/network failures.
   */
  submitApplePurchase: (jws: string) =>
    apiFetch<BackendUser | { user: BackendUser } | null>(
      "/api/billing/apple/purchase",
      { method: "POST", json: { jws } },
    ),

  /** Android mirror — same replay/at-least-once contract as Apple. */
  submitGooglePurchase: (purchaseToken: string, productId: string) =>
    apiFetch<BackendUser | { user: BackendUser } | null>(
      "/api/billing/google/purchase",
      { method: "POST", json: { purchaseToken, productId } },
    ),

  logout: () =>
    apiFetch<unknown>("/api/logout", {
      method: "POST",
      allowHtmlAsUnauth: true,
    }).catch(() => null),

  me: () => apiFetch<BackendUser | null>("/api/auth/user"),

  projects: () => apiFetch<BackendProject[]>("/api/projects"),

  project: (id: string | number) =>
    apiFetch<BackendProjectDetail>(`/api/projects/${id}`),

  createProject: (input: {
    name: string;
    address?: string | null;
    description?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    status?: string;
    color?: string;
    tags?: string[];
  }) =>
    apiFetch<BackendProject>("/api/projects", {
      method: "POST",
      json: input,
    }),

  updateProject: (
    id: number | string,
    patch: Partial<{
      name: string;
      address: string | null;
      description: string | null;
      latitude: number | null;
      longitude: number | null;
      status: string;
      color: string;
      tags: string[];
      coverPhotoId: number | null;
    }>,
  ) =>
    apiFetch<BackendProject>(`/api/projects/${id}`, {
      method: "PATCH",
      json: patch,
    }),

  tasks: () => apiFetch<BackendTask[]>("/api/tasks"),

  /**
   * Create a task on a project. Server stamps `createdById` from the
   * session and defaults `status` to "todo" — clients must NOT send
   * either field. Returns the created BackendTask (with joined
   * `assignedTo` if `assignedToId` was provided).
   */
  createTask: (
    projectId: string | number,
    input: {
      title: string;
      description?: string | null;
      priority?: BackendTaskPriority | null;
      assignedToId?: string | null;
      dueDate?: string | null;
      /**
       * Photo requirement (admin-only server-side; silently stripped
       * for non-admins). Server validates integer 0-100 — callers must
       * clamp before sending. Omit / null = no requirement.
       */
      requiredPhotoCount?: number | null;
    },
  ) =>
    apiFetch<BackendTask>(`/api/projects/${projectId}/tasks`, {
      method: "POST",
      json: input,
    }),

  /**
   * Patch a task. Server-side whitelist (anything else is silently
   * dropped): title, description, status, priority, assignedToId,
   * dueDate. Pass `null` to explicitly clear assignee / due date /
   * description / priority.
   */
  updateTask: (
    taskId: string | number,
    patch: Partial<{
      title: string;
      description: string | null;
      status: BackendTaskStatus;
      priority: BackendTaskPriority | null;
      assignedToId: string | null;
      dueDate: string | null;
    }>,
  ) =>
    apiFetch<BackendTask>(`/api/tasks/${taskId}`, {
      method: "PATCH",
      json: patch,
    }),

  /**
   * List a task's attached photos (task_photos join rows with the
   * joined media nested under `media`, including a presigned `url` —
   * same shape family as checklist item photos).
   */
  getTaskPhotos: (taskId: string | number) =>
    apiFetch<BackendTaskPhoto[]>(`/api/tasks/${taskId}/photos`),

  /**
   * Attach existing media rows to a task (bulk). Idempotent per
   * (task, media) pair — re-attaching an already-attached media is not
   * an error. Server rejects cross-project media with 400 and
   * cross-account media with 403; the picker only offers the task's own
   * project photos, so those are defensive paths, not expected flows.
   */
  attachPhotosToTask: (taskId: string | number, mediaIds: number[]) =>
    apiFetch<BackendTaskPhoto | BackendTaskPhoto[]>(
      `/api/tasks/${taskId}/photos`,
      { method: "POST", json: { mediaIds } },
    ),

  /** Detach a task photo by JOIN ROW id (not mediaId). Media row survives. */
  detachTaskPhoto: (taskPhotoId: string | number) =>
    apiFetch<void>(`/api/task-photos/${taskPhotoId}`, {
      method: "DELETE",
      allowEmptyBody: true,
    }),

  /** Delete a task. Server returns 204 No Content on success. */
  deleteTask: (taskId: string | number) =>
    apiFetch<void>(`/api/tasks/${taskId}`, {
      method: "DELETE",
      allowEmptyBody: true,
    }),

  // ----- Project public share tokens -----
  /**
   * Mint (or fetch the existing) public share token for a project.
   * The recipient-facing URL is `https://app.field-view.com/p/<token>`,
   * which renders the public read-only project page on the web app.
   * Server is idempotent: calling twice returns the same token.
   */
  shareProject: (projectId: string | number) =>
    apiFetch<BackendShareTokenResponse>(
      `/api/projects/${projectId}/share`,
      { method: "POST" },
    ),

  /**
   * Create a share link scoped to a SUBSET of a project's media.
   * Server contract: mediaIds required + non-empty, every id must
   * belong to the project. Returns 201 with the SharedGallery row —
   * use `response.token` to build the /gallery/<token> URL.
   */
  createSharedGallery: (payload: {
    projectId: number;
    mediaIds: number[];
    includeMetadata?: boolean;
    includeDescriptions?: boolean;
  }) =>
    apiFetch<BackendSharedGalleryResponse>("/api/galleries", {
      method: "POST",
      json: payload,
    }),

  /** Revoke the current public share token. Server returns 204. */
  unshareProject: (projectId: string | number) =>
    apiFetch<void>(`/api/projects/${projectId}/share`, {
      method: "DELETE",
      allowEmptyBody: true,
    }),

  /**
   * Delete a project (cascades its photos, tasks, and checklists on the
   * server). Server returns 204 No Content on success. apiFetch throws
   * an ApiError carrying the HTTP status + server `message` on non-2xx
   * (e.g. 403 permission, 409 "has time entries"), which callers surface.
   */
  deleteProject: (projectId: string | number) =>
    apiFetch<void>(`/api/projects/${projectId}`, {
      method: "DELETE",
      allowEmptyBody: true,
    }),

  // ----- Account / membership -----

  /**
   * Soft-delete the current user (leaves the team). Backend invalidates the
   * session; client must signOut + clear local state after this resolves.
   */
  deleteCurrentUser: () =>
    apiFetch<DeleteUserResponse>("/api/users/me", {
      method: "DELETE",
      json: { confirm: true },
    }),

  /**
   * Register the current device's Expo push token with the server so
   * it can deliver push notifications to this device. Server returns
   * 204 on success. Wire-only — caller is responsible for capturing
   * the token via expo-notifications first.
   */
  registerPushToken: (token: string) =>
    apiFetch<void>("/api/users/push-token", {
      method: "POST",
      json: { token },
      allowEmptyBody: true,
    }),

  /**
   * Clear the server-stored push token for the current user. Called
   * pre-logout so a signed-out device stops receiving pushes.
   * Server returns 204 on success.
   */
  unregisterPushToken: () =>
    apiFetch<void>("/api/users/push-token", {
      method: "DELETE",
      allowEmptyBody: true,
    }),

  // ----- Account-level settings (admin-managed, all users read) -----

  /**
   * Account-wide settings shared by every user on the team. Currently
   * carries only `defaultPhotoAspectRatio` (S3y, 2026-05) — the
   * aspect ratio every member's camera captures at. Read by every
   * user on bootstrap; modified only by admins via PATCH below.
   *
   * Response shape mirrors the web client. Mobile narrows the
   * `defaultPhotoAspectRatio` string to the local PhotoAspectRatio
   * union (services/imageProcessing.ts) before persisting — an
   * unexpected server value falls back to "4:3" silently rather than
   * propagating an unknown ratio to the cropper.
   */
  getAccountSettings: () =>
    apiFetch<{ defaultPhotoAspectRatio: string }>("/api/account/settings"),

  /**
   * Read-only billing summary. Admin-only — server returns 403 for
   * non-admin callers (mirror the gate client-side; billing UI is
   * hidden for non-admins). Display-only by design: no manage/upgrade
   * links on mobile (Apple flags external purchase paths).
   *
   * `billingProvider` is present on the wire but NOT reliable in the
   * current prod config — never branch UI on it.
   */
  getBillingSummary: () =>
    apiFetch<BillingSummary>("/api/account/billing-summary"),

  /**
   * Update one or more account-level settings. Admin-only — server
   * returns 403 for non-admin callers. Server returns the full
   * updated settings object so the caller can replace its local copy
   * in one shot.
   */
  /**
   * Onboarding / profile update. Server stamps profile_completed_at on
   * any successful call (the null→now transition fires the trial
   * lifecycle events server-side). industry and companySize are
   * admin-only and silently ignored for non-admins; jobRole is not
   * gated. Optional fields must be OMITTED when unselected — never
   * sent as null or "". Does NOT rotate the session id (only
   * req.login does), so follow-up authenticated requests are safe.
   *
   * tcpaAccepted is a consent record — send it ONLY when the user has
   * just affirmatively accepted (onboarding). Plain profile edits must
   * OMIT it so the server's original consent record is never touched.
   */
  updateMe: (input: {
    firstName: string;
    lastName: string;
    phone: string;
    tcpaAccepted?: boolean;
    jobRole?: string;
    industry?: string;
    companySize?: string;
    heardAboutUs?: string;
  }) =>
    apiFetch<BackendUser | { user: BackendUser } | null>("/api/auth/me", {
      method: "PATCH",
      json: input,
    }),

  /**
   * Rename the account (admin-only; server 403s otherwise). Server
   * normalizes with name.trim().slice(0, 200) — same as web register.
   */
  updateAccountName: (input: { name: string }) =>
    apiFetch<{ id: number | string; name: string }>("/api/account/name", {
      method: "PATCH",
      json: input,
    }),

  updateAccountSettings: (input: { defaultPhotoAspectRatio?: string }) =>
    apiFetch<{ defaultPhotoAspectRatio: string }>("/api/account/settings", {
      method: "PATCH",
      json: input,
    }),

  /**
   * Soft-delete the entire account (owner only). Requires the literal
   * string "DELETE" plus the owner's password. Backend returns 401 for
   * wrong password, 400 for OAuth-only owners (with a /forgot-password
   * hint in the message), 403 for non-owners.
   */
  deleteAccount: (confirmText: string, password: string) =>
    apiFetch<DeleteAccountResponse>("/api/account", {
      method: "DELETE",
      json: { confirmText, password },
    }),

  /**
   * Step 1: ask the backend for presigned S3 PUT URLs for 1–20 files. The
   * response array order matches the input order 1:1.
   */
  signUploads: (files: SignUploadFile[]) =>
    apiFetch<SignUploadResponse[]>("/api/uploads/sign", {
      method: "POST",
      json: { files },
    }),

  /**
   * Step 2: PUT raw file bytes directly to the presigned S3 URL. Reads the
   * local file via the React Native fetch(uri) → blob() bridge and uploads
   * the blob with the matching Content-Type and Content-Length headers.
   * Throws `UploadExpiredError` on 403 + SignatureDoesNotMatch so callers
   * can re-request a fresh signed URL and retry.
   */
  uploadToS3: async (
    uploadUrl: string,
    fileUri: string,
    mimeType: string,
    fileSize: number,
    // Files sign flow only: bakes Content-Disposition into the PUT
    // signature; must be sent VERBATIM alongside Content-Type or S3
    // rejects with SignatureDoesNotMatch. Photos flow passes nothing.
    contentDisposition?: string,
  ): Promise<void> => {
    let body: Blob;
    try {
      const fileRes = await fetch(fileUri);
      body = await fileRes.blob();
    } catch (e) {
      throw new ApiError(
        0,
        `Failed to read local file: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    let res: Response;
    try {
      console.log("[api] → PUT (s3)", uploadUrl.split("?")[0]);
      res = await fetch(uploadUrl, {
        method: "PUT",
        body,
        headers: {
          "Content-Type": mimeType,
          "Content-Length": String(fileSize),
          ...(contentDisposition
            ? { "Content-Disposition": contentDisposition }
            : {}),
        },
      });
      console.log("[api] ← (s3)", res.status);
    } catch (e) {
      throw new ApiError(
        0,
        `S3 upload network failure: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (res.status === 403) {
      const text = await res.text().catch(() => "");
      if (text.includes("SignatureDoesNotMatch")) {
        throw new UploadExpiredError();
      }
      throw new ApiError(403, `S3 upload forbidden: ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(
        res.status,
        `S3 upload failed (${res.status}): ${text.slice(0, 200)}`,
      );
    }
  },

  /**
   * Step 3: record successfully-uploaded media in the database, attaching
   * them to a project. Returns the created Media rows.
   */
  createMedia: (
    projectId: string,
    files: CreateMediaFile[],
    caption?: string | null,
    tags?: string[],
  ) => {
    const body: Record<string, unknown> = { files };
    if (caption !== undefined) body.caption = caption;
    if (tags !== undefined) body.tags = tags;
    return apiFetch<CreateMediaResponse[]>(
      `/api/projects/${projectId}/media`,
      { method: "POST", json: body },
    );
  },

  // ----- Team / invitations (web rework, 2026-05) -----

  /**
   * All users in the caller's account (active + soft-deleted; includes
   * the caller themselves). Used by the "Add user to project" picker —
   * the caller is responsible for filtering out self, soft-deleted
   * (deletedAt != null), and users already on the target project.
   */
  listAccountUsers: () => apiFetch<BackendUser[]>("/api/users"),

  /**
   * Account users that the caller is allowed to assign work to.
   *
   * Without `assignableForProjectId`, identical to `listAccountUsers`
   * (returns every user in the account). With `assignableForProjectId`,
   * the server applies the role-aware filter (web parity, 2026-05):
   *  - admin / manager / standard → always returned
   *  - restricted → only returned if explicitly in `project_assignments`
   *    for that project
   *
   * Consumed by the task assignee picker so restricted users who
   * aren't on the project don't show up there.
   *
   * `assignableForProjectId` is dropped when undefined / null / empty
   * string — never sent as `?assignableForProjectId=` with no value
   * (the server would treat that as "filter by project id ''", which
   * is not the same as "no filter").
   */
  listUsers: (opts?: { assignableForProjectId?: string | number }) => {
    const pid = opts?.assignableForProjectId;
    const hasPid = pid !== undefined && pid !== null && String(pid).length > 0;
    const qs = hasPid
      ? `?assignableForProjectId=${encodeURIComponent(String(pid))}`
      : "";
    return apiFetch<BackendUser[]>(`/api/users${qs}`);
  },

  // TODO: not used in mobile yet; web handles invites. Mobile consumer
  // = invitations list view if/when we build it.
  /** All pending invitations for the current account (admin scope). */
  listInvitations: () =>
    apiFetch<BackendInvitation[]>("/api/invitations"),

  /**
   * Send a team invite. The server creates an `invitations` row, emails
   * the recipient an accept link, and (when role === "restricted") writes
   * the assignedProjectIds onto the row so the future user is project-
   * scoped on accept.
   *
   * `assignedProjectIds` is sent ONLY when role === "restricted" — the
   * server 400s if it's present for other roles, and ignores it if
   * empty. Caller is responsible for the role-conditional include.
   *
   * Known server error codes the modal handles inline:
   *   409 trial_cap_reached     — account on free trial, hit user cap
   *   409 no_seats_available    — paid plan, all seats consumed
   *   409 duplicate ("already been sent") — pending invite for this email
   *   403                       — caller isn't allowed to invite at this role
   *   400                       — missing/invalid fields
   *
   * TODO: not used in mobile yet; web handles invites. Mobile consumer
   * = invitations list view if/when we build it.
   */
  createInvitation: (input: {
    email: string;
    firstName: string;
    lastName: string;
    role: UserRole;
    assignedProjectIds?: number[];
  }) =>
    apiFetch<BackendInvitation>("/api/invitations", {
      method: "POST",
      json: input,
    }),

  // TODO: not used in mobile yet; web handles invites. Mobile consumer
  // = invitations list view if/when we build it.
  /** Cancel a pending invitation (admin only on the server). */
  cancelInvitation: (id: string | number) =>
    apiFetch<void>(`/api/invitations/${id}`, {
      method: "DELETE",
      allowEmptyBody: true,
    }),

  /** Real "who has access to this project" list. Replaces the local-only ShareLink cache. */
  listProjectAssignments: (projectId: string | number) =>
    apiFetch<BackendProjectAssignment[]>(
      `/api/projects/${projectId}/assignments`,
    ),

  /** Grant an existing user access to a project (restricted-role assignment edit). */
  assignUserToProject: (projectId: string | number, userId: string) =>
    apiFetch<BackendProjectAssignment>(
      `/api/projects/${projectId}/assignments`,
      { method: "POST", json: { userId } },
    ),

  /**
   * Remove a user from a project. Their account isn't deleted — they
   * just lose access to this one project. UX copy mirrors that distinction.
   */
  unassignUserFromProject: (projectId: string | number, userId: string) =>
    apiFetch<void>(
      `/api/projects/${projectId}/assignments/${userId}`,
      { method: "DELETE", allowEmptyBody: true },
    ),

  // ===== Checklists v2 (server-backed; field-MVP, 2026-05) =====
  // Read everything; write item values, notes, photo attachments, and
  // template-application. Cannot author new instances/items/templates
  // (web-only). Endpoint contracts mirror the v2 schema described in the
  // shipping spec — backend support is a peer change. If a path 404s,
  // the spec author has the source of truth.

  /**
   * Project's checklist instances (id/title/template/createdAt only).
   *
   * The server doesn't expose a per-project list endpoint — only the
   * account-scoped `GET /api/checklists`. We fetch that and filter
   * client-side on `projectId`. The v2 schema guarantees `projectId`
   * on every row, so this is a type-safe filter (no shape changes).
   */
  listChecklistsForProject: async (projectId: string | number) => {
    const all = await apiFetch<BackendChecklist[]>(`/api/checklists`);
    const target = String(projectId);
    return (Array.isArray(all) ? all : []).filter(
      (c) => String(c.projectId) === target,
    );
  },

  /** Sections within a checklist instance, in sortOrder. */
  listChecklistSections: (checklistId: string | number) =>
    apiFetch<BackendChecklistSection[]>(
      `/api/checklists/${checklistId}/sections`,
    ),

  /** All items within a checklist instance (across sections), in sortOrder. */
  listChecklistItems: (checklistId: string | number) =>
    apiFetch<BackendChecklistItem[]>(
      `/api/checklists/${checklistId}/items`,
    ),

  /** Multiple-choice options for a single item (empty for non-MC items). */
  listChecklistItemOptions: (itemId: string | number) =>
    apiFetch<BackendChecklistItemOption[]>(
      `/api/checklist-items/${itemId}/options`,
    ),

  /** Photos already attached to a single item. */
  listChecklistItemPhotos: (itemId: string | number) =>
    apiFetch<BackendChecklistItemPhoto[]>(
      `/api/checklist-items/${itemId}/photos`,
    ),

  /**
   * Patch one or more value fields on an item. Pass only the fields you
   * intend to change; omitted fields are untouched server-side. Server
   * stamps completedAt automatically when the item transitions from
   * "no value" → "any value" (and clears it on the reverse), so callers
   * generally do not need to send completedAt themselves.
   */
  updateChecklistItem: (
    itemId: string | number,
    patch: Partial<{
      valueBool: boolean | null;
      valueRating: number | null;
      valueText: string | null;
      selectedOptionId: number | null;
      notes: string | null;
      assignedToUserId: string | null;
      completedAt: string | null;
    }>,
  ) =>
    apiFetch<BackendChecklistItem>(`/api/checklist-items/${itemId}`, {
      method: "PATCH",
      json: patch,
    }),

  /**
   * Attach an existing media row to a checklist item. Returns the
   * created junction row (id + mediaId + url for immediate render).
   * Idempotent on (itemId, mediaId) server-side.
   */
  attachPhotoToItem: async (itemId: string | number, mediaId: number) => {
    // Server expects { mediaIds: number[] } (plural array) and may return
    // either a single junction row or an array of them depending on
    // version. We wrap on send and accept either shape on receive — all
    // current call sites attach a single mediaId at a time so the (itemId,
    // mediaId) signature stays unchanged for callers.
    const response = await apiFetch<
      BackendChecklistItemPhoto | BackendChecklistItemPhoto[]
    >(`/api/checklist-items/${itemId}/photos`, {
      method: "POST",
      json: { mediaIds: [mediaId] },
    });
    if (Array.isArray(response)) {
      if (response.length === 0)
        throw new Error("Server returned no photo for attach.");
      return response[0];
    }
    return response;
  },

  /** Detach a previously-attached photo. The media row itself is preserved. */
  detachPhotoFromItem: (itemPhotoId: string | number) =>
    apiFetch<void>(`/api/checklist-item-photos/${itemPhotoId}`, {
      method: "DELETE",
      allowEmptyBody: true,
    }),

  /** Available templates for the current account. Used by the picker modal. */
  listChecklistTemplates: () =>
    apiFetch<BackendChecklistTemplate[]>("/api/checklist-templates"),

  /**
   * Apply a template to a project: server clones the template's sections +
   * items into a fresh checklist instance and returns it. The list view
   * should refetch after this resolves.
   */
  /**
   * Walkthrough capture: submit the narration transcript + this
   * session's uploaded media ids (+ per-photo timing offsets from the
   * recording start). Server generates the report ASYNCHRONOUSLY and
   * push-notifies with data.type "walkthrough_report_ready" — the 202
   * only acknowledges the job started.
   */
  generateWalkthrough: (
    projectId: string | number,
    body: {
      transcript: string;
      mediaIds: number[];
      photoOffsets?: Array<{ mediaId: number; offsetMs: number }>;
    },
  ) =>
    apiFetch<{ status: string; reportId: number | string }>(
      `/api/projects/${projectId}/walkthrough`,
      {
        method: "POST",
        json: body,
      },
    ),

  /**
   * Generate a checklist from a free-text description (typed or a
   * voice-note transcript). Server does the AI pass and creates the
   * checklist in one shot. 400 = nothing actionable found in the
   * description, 429 = monthly generation limit — both carry readable
   * messages for inline display.
   */
  generateChecklist: (projectId: string | number, note: string) =>
    apiFetch<{ checklistId: number; itemCount: number }>(
      `/api/projects/${projectId}/checklists/generate`,
      { method: "POST", json: { note } },
    ),

  applyChecklistTemplate: (
    projectId: string | number,
    templateId: string | number,
    title: string,
  ) =>
    apiFetch<BackendChecklist>(`/api/projects/${projectId}/checklists`, {
      method: "POST",
      // Server requires `title` on POST — it does NOT auto-derive it
      // from the template, so we forward the template's own title
      // verbatim (exact mirror). `templateId` is the clone signal:
      // server still uses it to copy sections/items into the new
      // instance. Future feature: in-app rename on the instance.
      json: { title, templateId },
    }),

  /**
   * Create a blank (manual) checklist. Same endpoint as
   * applyChecklistTemplate minus the clone signal — `items: []`
   * creates it empty; items/sections are then managed on web (or a
   * future in-app editor).
   */
  createChecklist: (projectId: string | number, title: string) =>
    apiFetch<BackendChecklist>(`/api/projects/${projectId}/checklists`, {
      method: "POST",
      json: { title, items: [] },
    }),

  /**
   * Delete a checklist instance. Server returns 200 {message:"Deleted"};
   * FK cascade removes sections, items, item options, photo joins, and
   * responses. The underlying media rows are preserved (only the join
   * rows in checklist_item_photos are dropped).
   */
  deleteChecklist: (checklistId: string | number) =>
    apiFetch<{ message: string }>(`/api/checklists/${checklistId}`, {
      method: "DELETE",
    }),

  // ----- Media delete + references -----
  /**
   * Hard-delete a media row. Server cascades all join rows
   * (checklist_item_photos, report_section_photos) and removes the
   * underlying S3 object. Returns {success:true}.
   *
   * Callers should typically call `getMediaReferences` first to warn
   * the user about reports/checklists this photo is attached to. The
   * batch (multi-select) path skips the references check intentionally
   * — see TECH_DEBT.md.
   */
  deleteMedia: (mediaId: string | number) =>
    apiFetch<{ success: boolean }>(`/api/media/${mediaId}`, {
      method: "DELETE",
    }),

  /**
   * Where is this media referenced? Server filters by the caller's
   * visibility (a restricted user only sees rows they can otherwise
   * read), so we never get back something they shouldn't be able to
   * preview. tasks[] is always empty by current server contract.
   */
  getMediaReferences: (mediaId: string | number) =>
    apiFetch<MediaReferences>(`/api/media/${mediaId}/references`),

  /**
   * List a photo's comments, newest-first. `user` is ABSENT when the
   * comment's author was deleted — callers render a fallback name.
   */
  getMediaComments: (mediaId: number) =>
    apiFetch<BackendCommentResponse[]>(`/api/media/${mediaId}/comments`),

  /**
   * Create a comment. Server returns 201 with the BARE comment row —
   * no joined `user` object — so callers must RE-FETCH the list after
   * a successful post instead of appending the response locally.
   * 400 on empty content (callers should trim + guard first).
   */
  createMediaComment: (mediaId: number, content: string) =>
    apiFetch<BackendCommentResponse>(`/api/media/${mediaId}/comments`, {
      method: "POST",
      json: { content },
    }),

  /**
   * Translate arbitrary text. Server auto-targets the language
   * (English → Spanish, anything else → English) — the client never
   * picks one.
   */
  translateText: (text: string) =>
    apiFetch<{ translation: string }>(`/api/translate`, {
      method: "POST",
      json: { text },
    }),

  /**
   * Transcribe a recorded voice note via S3 (contract change, 2026-08:
   * Vercel caps request bodies at 4.5MB, so raw-body POSTs died on any
   * recording past ~4 minutes). Three steps:
   *
   *   1. POST /api/uploads/sign { files: [{ folder: "audio",
   *      originalName, mimeType, fileSize }] } — folder is PER FILE
   *      (same contract as the files flow / SignFileUploadItem).
   *      originalName's extension and mimeType are validated AS A PAIR
   *      by the server (.m4a ↔ audio/mp4). No publicUrl for audio.
   *   2. PUT bytes to uploadUrl with Content-Type + the sign response's
   *      contentDisposition VERBATIM (baked into the PUT signature —
   *      same contract as the files flow; never reconstruct it).
   *   3. POST /api/transcribe { key } → { transcript }.
   *
   * Bytes are read via the same fetch(uri) → blob() bridge uploadToS3
   * uses. No client-side size ceiling — S3 PUT has none that we'd hit.
   * Steps 1 and 3 go through apiFetch (plain JSON), so session-cookie
   * handling is the standard 2xx-only policy.
   *
   * Distinct failure messages per step so a screenshot tells us which
   * leg broke: presign → "Couldn't start upload.", PUT → "Couldn't
   * upload the recording.", transcribe → the server's message.
   */
  transcribeAudio: async (
    uri: string,
    mimeType: string,
  ): Promise<{ transcript: string }> => {
    let blob: Blob;
    try {
      const fileRes = await fetch(uri);
      blob = await fileRes.blob();
    } catch (e) {
      throw new ApiError(
        0,
        `Failed to read recording file: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // Extension must match the mime — the server validates the pair.
    // Recordings are audio/mp4 (.m4a) on both platforms; fall back to
    // the mime subtype for anything unexpected.
    const ext =
      mimeType === "audio/mp4"
        ? "m4a"
        : (mimeType.split("/")[1] ?? "m4a").split(";")[0];
    const originalName = `recording-${Date.now()}.${ext}`;

    // 1. Presign. Field names match server/routes.ts (f.folder,
    // f.originalName, f.mimeType, f.fileSize) — the same per-file
    // shape the files sign flow (SignFileUploadItem) already speaks.
    let signed: { key: string; uploadUrl: string; contentDisposition: string };
    try {
      const res = await apiFetch<
        { key: string; uploadUrl: string; contentDisposition: string }[]
      >("/api/uploads/sign", {
        method: "POST",
        json: {
          files: [
            {
              folder: "audio",
              originalName,
              mimeType,
              fileSize: blob.size,
            },
          ],
        },
      });
      if (!res[0]?.uploadUrl) {
        throw new ApiError(0, "Sign response was empty.");
      }
      signed = res[0];
    } catch (e) {
      throw new ApiError(
        e instanceof ApiError ? e.status : 0,
        "Couldn't start upload.",
      );
    }

    // 2. PUT to S3 — Content-Disposition verbatim from the sign
    // response or the signature check fails.
    try {
      console.log("[api] → PUT (s3, audio)", signed.uploadUrl.split("?")[0]);
      const putRes = await fetch(signed.uploadUrl, {
        method: "PUT",
        body: blob,
        headers: {
          "Content-Type": mimeType,
          "Content-Length": String(blob.size),
          "Content-Disposition": signed.contentDisposition,
        },
      });
      console.log("[api] ← (s3, audio)", putRes.status);
      if (!putRes.ok) {
        throw new ApiError(putRes.status, "s3 put failed");
      }
    } catch (e) {
      throw new ApiError(
        e instanceof ApiError ? e.status : 0,
        "Couldn't upload the recording.",
      );
    }

    // 3. Transcribe by key. Server errors surface as-is (apiFetch
    // throws ApiError carrying the server's message).
    return apiFetch<{ transcript: string }>("/api/transcribe", {
      method: "POST",
      json: { key: signed.key },
    });
  },

  // ----- Media annotations (cross-platform sync, 2026-06) -----
  //
  // Annotations live in their own table, one row PER USER per media, and
  // are NOT included in the project detail GET — they're fetched per-media
  // on photo open. Stroke payloads use the canonical wire format
  // (normalized 0..1 points, width in 1000-units); conversion to/from the
  // mobile px model happens in services/annotations.ts at the call edge.
  /** List every user's annotation row for a media (the render-set union). */
  listMediaAnnotations: (mediaId: string | number) =>
    apiFetch<BackendAnnotationRow[]>(`/api/media/${mediaId}/annotations`),
  /** Create the caller's annotation row for a media. Returns the new row (carry `id`). */
  createMediaAnnotation: (
    mediaId: string | number,
    strokes: CanonicalStroke[],
  ) =>
    apiFetch<BackendAnnotationRow>(`/api/media/${mediaId}/annotations`, {
      method: "POST",
      json: { strokes },
    }),
  /** Replace the strokes of the caller's existing annotation row. */
  updateAnnotation: (id: string | number, strokes: CanonicalStroke[]) =>
    apiFetch<BackendAnnotationRow>(`/api/annotations/${id}`, {
      method: "PUT",
      json: { strokes },
    }),
  /** Delete the caller's annotation row. Tolerates an empty (204) body. */
  deleteAnnotation: (id: string | number) =>
    apiFetch<void>(`/api/annotations/${id}`, {
      method: "DELETE",
      allowEmptyBody: true,
    }),

  // ----- Reports (Mobile Reports R1) -----
  // DELETE endpoints in this group return 200 + body `{message: "Deleted"}`
  // (NOT 204 — that's the tasks endpoint's contract). `allowEmptyBody`
  // is set so that if the server is upgraded to 204 in the future, the
  // mobile call keeps working without code changes.

  /** Project-scoped list of report rows (no sections / no photos). */
  listReportsForProject: (projectId: string | number) =>
    apiFetch<BackendReport[]>(`/api/projects/${projectId}/reports`),

  listFilesForProject: (projectId: string | number) =>
    apiFetch<BackendProjectFile[]>(`/api/projects/${projectId}/files`),

  /** Sign flow for project files (folder: "files"). Response order
   *  matches input order 1:1, same as the photo sign flow. */
  signFileUploads: (files: SignFileUploadItem[]) =>
    apiFetch<SignFileUploadResponse[]>("/api/uploads/sign", {
      method: "POST",
      json: { files },
    }),

  /** Register uploaded files against a project (step 3 of the files
   *  upload flow). */
  registerProjectFiles: (
    projectId: string | number,
    files: RegisterProjectFileItem[],
  ) =>
    apiFetch<BackendProjectFile[]>(`/api/projects/${projectId}/files`, {
      method: "POST",
      json: { files },
    }),

  /** Full report tree: report + sections + per-section photos with URLs. */
  getReport: (id: string | number) =>
    apiFetch<BackendReportTreeResponse>(`/api/reports/${id}`),

  /**
   * Create a report on a project. Pass `templateId` to instantiate from
   * a template (server clones the template's sections); OMIT it (don't
   * send null/0) for a blank report.
   */
  createReport: (
    projectId: string | number,
    input: {
      title: string;
      description?: string;
      templateId?: string | number;
    },
  ) => {
    const body: Record<string, unknown> = { title: input.title };
    if (input.description !== undefined) body.description = input.description;
    if (input.templateId !== undefined && input.templateId !== null) {
      body.templateId = input.templateId;
    }
    return apiFetch<BackendReport>(`/api/projects/${projectId}/reports`, {
      method: "POST",
      json: body,
    });
  },

  /**
   * AI report generation from selected photos + optional note.
   * POST /api/projects/:id/reports/generate — SYNCHRONOUS: the server
   * runs the full AI pass before responding, which can take tens of
   * seconds. The long explicit timeout exists only to surface a truly
   * hung connection; callers MUST show blocking progress UI and MUST
   * NOT present a client-side timeout as a server failure (the report
   * may still have been created — tell the user to check the list).
   *
   * 201 {reportId, excludedCount} · 400 invalid input · 429 monthly
   * limit · 503 AI service busy · 500 generation error. mediaIds
   * capped at 75 (client enforces; server backstops). note <= 5000.
   */
  generateProjectReport: (
    projectId: string | number,
    input: { mediaIds: number[]; note?: string; reportType: ReportType },
  ) => {
    const body: Record<string, unknown> = {
      mediaIds: input.mediaIds,
      reportType: input.reportType,
    };
    if (input.note !== undefined && input.note.trim().length > 0) {
      body.note = input.note.trim();
    }
    return apiFetch<{ reportId: number | string; excludedCount: number }>(
      `/api/projects/${projectId}/reports/generate`,
      { method: "POST", json: body, timeoutMs: 180_000 },
    );
  },

  updateReport: (
    id: string | number,
    patch: Partial<{
      title: string;
      description: string | null;
      coverConfig: unknown;
      status: ReportStatus;
    }>,
  ) =>
    apiFetch<BackendReport>(`/api/reports/${id}`, {
      method: "PATCH",
      json: patch,
    }),

  deleteReport: (id: string | number) =>
    apiFetch<void>(`/api/reports/${id}`, {
      method: "DELETE",
      allowEmptyBody: true,
    }),

  addReportSection: (
    reportId: string | number,
    input: { title: string; summary?: string },
  ) =>
    apiFetch<BackendReportSection>(`/api/reports/${reportId}/sections`, {
      method: "POST",
      json: input,
    }),

  /** NOTE the path is /api/sections/:id, NOT /api/report-sections/:id. */
  updateReportSection: (
    sectionId: string | number,
    patch: Partial<{
      title: string;
      summary: string | null;
      sortOrder: number;
    }>,
  ) =>
    apiFetch<BackendReportSection>(`/api/sections/${sectionId}`, {
      method: "PATCH",
      json: patch,
    }),

  deleteReportSection: (sectionId: string | number) =>
    apiFetch<void>(`/api/sections/${sectionId}`, {
      method: "DELETE",
      allowEmptyBody: true,
    }),

  /**
   * Batch-attach existing project media to a section. Server enforces
   * mediaIds.length in [1, 50] AND that every mediaId belongs to the
   * report's project (else the entire batch 400s — no partial commits).
   * Returns the created junction rows in their final sortOrder.
   */
  attachPhotosToSection: (
    sectionId: string | number,
    mediaIds: number[],
  ) =>
    apiFetch<BackendReportSectionPhoto[]>(
      `/api/sections/${sectionId}/photos`,
      { method: "POST", json: { mediaIds } },
    ),

  /** NOTE the path is /api/section-photos/:id, NOT /api/report-section-photos/:id. */
  updateSectionPhoto: (
    photoId: string | number,
    patch: Partial<{
      caption: string | null;
      description: string | null;
      sortOrder: number;
    }>,
  ) =>
    apiFetch<BackendReportSectionPhoto>(`/api/section-photos/${photoId}`, {
      method: "PATCH",
      json: patch,
    }),

  detachSectionPhoto: (photoId: string | number) =>
    apiFetch<void>(`/api/section-photos/${photoId}`, {
      method: "DELETE",
      allowEmptyBody: true,
    }),

  /** All report templates available to the current account. */
  listReportTemplates: () =>
    apiFetch<BackendReportTemplate[]>("/api/report-templates"),

  // ----- Report public share tokens -----
  /**
   * Mint (or fetch the existing) public share token for a report.
   * The recipient-facing URL is
   * `https://app.field-view.com/report/<token>`. Server is idempotent
   * like the project variant; 409 = report is still generating.
   */
  shareReport: (reportId: string | number) =>
    apiFetch<BackendShareTokenResponse>(`/api/reports/${reportId}/share`, {
      method: "POST",
    }),

  /** Revoke the report's current public share token. Server returns 204. */
  unshareReport: (reportId: string | number) =>
    apiFetch<void>(`/api/reports/${reportId}/share`, {
      method: "DELETE",
      allowEmptyBody: true,
    }),

  /**
   * Generate a server-rendered PDF and return it as a Blob.
   *
   * SPECIAL: this endpoint returns `application/pdf` (binary), not
   * JSON, so it cannot use apiFetch — that helper insists on a JSON
   * content-type. We replicate apiFetch's auth path here:
   *  - on native, attach the Cookie header from the in-memory jar,
   *  - on web, rely on `credentials: "include"`,
   *  - capture rotated session cookies from the response,
   *  - parse JSON error bodies on 4xx/5xx for a useful message.
   *
   * Server contract: 50-photo cap enforced — caller should surface the
   * count next to the trigger UI and disable at the cap.
   */
  generateReportPdf: async (reportId: string | number): Promise<Blob> => {
    if (!API_BASE_URL) {
      throw new ApiError(
        0,
        "EXPO_PUBLIC_API_BASE_URL is not configured. Check artifacts/mobile/.env.",
      );
    }
    if (!loaded) await loadSession();
    const headers: Record<string, string> = {
      Accept: "application/pdf",
      "X-FieldView-Client": "mobile-1",
    };
    if (cookieJar.size > 0 && Platform.OS !== "web") {
      headers["Cookie"] = serializeCookieJar();
    }
    let res: Response;
    try {
      res = await fetch(`${API_BASE_URL}/api/reports/${reportId}/pdf`, {
        method: "POST",
        headers,
        credentials: Platform.OS === "web" ? "include" : "omit",
      });
    } catch (e) {
      breadcrumbApiError("POST", `/api/reports/${reportId}/pdf`, 0);
      throw new ApiError(
        0,
        `Network request failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // Same rule as apiFetch: never ingest Set-Cookie from an error
    // response — it could clobber the authenticated session cookie.
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      if (res.ok) {
        parseAndPersistSetCookie(setCookie);
      } else {
        console.warn(
          `[api] DISCARDED Set-Cookie on error response: POST /api/reports/${reportId}/pdf status=${res.status}`,
        );
        Sentry.addBreadcrumb({
          category: "session",
          level: "warning",
          message: "Set-Cookie discarded on error response",
          data: { method: "POST", path: `/api/reports/${reportId}/pdf`, status: res.status },
        });
        Sentry.captureMessage("Set-Cookie discarded on error response", {
          level: "warning",
          extra: { method: "POST", path: `/api/reports/${reportId}/pdf`, status: res.status },
        });
      }
    }
    if (!res.ok) {
      let message = `PDF request failed (${res.status})`;
      try {
        const ct = res.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          const j = (await res.json()) as { message?: unknown };
          if (j && typeof j.message === "string") message = j.message;
        }
      } catch {
        /* ignore — fall back to generic message */
      }
      breadcrumbApiError("POST", `/api/reports/${reportId}/pdf`, res.status);
      throw new ApiError(res.status, message);
    }
    return await res.blob();
  },
};

/** Normalize the various user shapes the backend might return. */
export function normalizeUser(raw: unknown): BackendUser | null {
  if (!raw || typeof raw !== "object") return null;
  const maybeWrapped = raw as { user?: BackendUser };
  const u = (maybeWrapped.user ?? raw) as BackendUser;
  if (!u || typeof u !== "object" || !("email" in u)) return null;
  return u;
}
