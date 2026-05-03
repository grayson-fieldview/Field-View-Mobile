import { Platform } from "react-native";
import { secureStorage } from "./secureStorage";

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

/** Load the persisted cookie jar into memory (call once on app start). */
export async function loadSession(): Promise<string | null> {
  if (loaded) return cookieJar.size ? serializeCookieJar() : null;
  loaded = true;
  const raw = await secureStorage.getItem(COOKIE_STORAGE_KEY);
  console.log("[cookie-migration] loaded from storage:", raw);
  if (!raw) {
    console.log("[cookie-migration] after dedup: (empty)");
    console.log("[cookie-migration] differs:", false);
    return null;
  }

  // One-time migration: dedupe any duplicate cookie names that the
  // previous append-style logic may have written. Last value wins.
  cookieJar.clear();
  ingestSerializedJar(raw);
  const cleaned = serializeCookieJar();
  console.log("[cookie-migration] after dedup:", cleaned);
  console.log("[cookie-migration] differs:", raw !== cleaned);
  if (cleaned !== raw) {
    secureStorage.setItem(COOKIE_STORAGE_KEY, cleaned).catch(() => {});
  }
  return cleaned || null;
}

/** Clear the in-memory and on-disk cookie jar. */
export async function clearSession(): Promise<void> {
  cookieJar.clear();
  loaded = true;
  await secureStorage.removeItem(COOKIE_STORAGE_KEY);
}

export function hasSession(): boolean {
  return cookieJar.size > 0;
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
  secureStorage.setItem(COOKIE_STORAGE_KEY, serializeCookieJar()).catch(() => {});
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
   * Current callers: api.autoUndoTimeEntry. Future: any S32+
   * endpoint that returns 204 (cancel pending exit, etc.).
   */
  allowEmptyBody?: boolean;
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
  // for web isn't usable here. Mobile MUST ship this before web
  // CSRF flips to enforce mode, or every state-changing call 403s.
  // Header value is versioned so future deprecations don't brick
  // older mobile builds.
  const method = opts.method ?? "GET";
  if (method !== "GET") {
    headers["X-FieldView-Client"] = "mobile-1";
  }
  console.log("[cookie-outgoing]", headers["Cookie"]);

  let res: Response;
  try {
    console.log("[api] →", opts.method ?? "GET", API_BASE_URL + path);
    console.log("[api] Cookie being sent:", headers["Cookie"] || "(none)");
    res = await fetch(`${API_BASE_URL}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body,
      credentials: Platform.OS === "web" ? "include" : "omit",
    });
    console.log("[api] ←", res.status, path);
    const setCookieHeader = res.headers.get("set-cookie");
    if (setCookieHeader) console.log("[api] Set-Cookie received:", setCookieHeader);
  } catch (e) {
    throw new ApiError(
      0,
      `Network request failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Capture any new/rotated session cookies.
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) parseAndPersistSetCookie(setCookie);

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
    throw new ApiError(
      res.status,
      "Unexpected non-JSON response from API — the endpoint may not exist or you may be logged out.",
      text.slice(0, 300),
    );
  }

  return (await res.json()) as T;
}

// ----- Types returned by the backend -----
export interface BackendUser {
  id: string | number;
  email: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  /** Owner flag from /api/auth/user (web backend, deployed 2026-04-28). */
  isOwner?: boolean;
  [key: string]: unknown;
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
  caption?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  tags?: string[] | null;
  createdAt: string;
}

export interface BackendTask {
  id: number | string;
  projectId: number | string;
  title: string;
  description?: string | null;
  status?: string | null;
  priority?: string | null;
  dueDate?: string | null;
  createdAt: string;
  updatedAt?: string;
  project?: { name?: string };
}

export interface BackendTimesheetEntry {
  id: number | string;
  userId: string;
  projectId: number | string;
  accountId?: string;
  clockIn: string;
  clockOut: string | null;
  source?: string | null;
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface BackendProjectDetail {
  project: BackendProject;
  media?: BackendMedia[];
  tasks?: BackendTask[];
  checklists?: unknown[];
  reports?: unknown[];
}

/**
 * Geofence-eligible project (server-side filtered + sorted + capped).
 * Server guarantees: accountId match, !archived, lat/lng non-null,
 * lastActivityAt within last 14 days, sorted DESC by lastActivityAt,
 * limit 20. Restricted-role users see only assigned projects.
 *
 * `lastActivityAt` is treated as opaque on mobile (sort key only,
 * already sorted server-side).
 */
export interface BackendGeofenceEligibleProject {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  lastActivityAt: string;
}

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

// ----- Endpoint wrappers -----
export const api = {
  base: API_BASE_URL,

  login: (email: string, password: string) =>
    apiFetch<BackendUser | { user: BackendUser } | null>("/api/login", {
      method: "POST",
      json: { email, password },
    }),

  logout: () =>
    apiFetch<unknown>("/api/logout", {
      method: "POST",
      allowHtmlAsUnauth: true,
    }).catch(() => null),

  me: () => apiFetch<BackendUser | null>("/api/auth/user"),

  projects: () => apiFetch<BackendProject[]>("/api/projects"),

  project: (id: string | number) =>
    apiFetch<BackendProjectDetail>(`/api/projects/${id}`),

  geofenceEligibleProjects: () =>
    apiFetch<BackendGeofenceEligibleProject[]>(
      "/api/projects/geofence-eligible",
    ),

  tasks: () => apiFetch<BackendTask[]>("/api/tasks"),

  // ----- Timesheets (manual clock-in/out) -----
  activeTimesheet: () =>
    apiFetch<BackendTimesheetEntry | null>("/api/timesheets/active"),

  /**
   * Clock the user in to a project.
   *
   * `source` is optional and only added to the request body when
   * explicitly provided. Existing manual call sites pass undefined →
   * field is omitted → backend treats as default "manual". The S31a
   * geofence-confirmation banner passes "auto_geofence" to flag the
   * entry as automatically triggered.
   *
   * Wire-contract note: the literal MUST match the postgres
   * `time_entries.source` enum exactly. As of web commit dbc5b35,
   * the enum is `[manual, auto_geofence, edited]` and the server
   * 400s on any other value (no coercion, no "auto" alias).
   */
  clockIn: (
    projectId: string | number,
    notes?: string,
    source?: "auto_geofence" | "manual",
  ) => {
    const body: Record<string, unknown> = { projectId };
    if (notes !== undefined) body.notes = notes;
    if (source !== undefined) body.source = source;
    return apiFetch<BackendTimesheetEntry>("/api/timesheets/clock-in", {
      method: "POST",
      json: body,
    });
  },

  clockOut: (notes?: string) =>
    apiFetch<BackendTimesheetEntry>("/api/timesheets/clock-out", {
      method: "POST",
      json: notes !== undefined ? { notes } : {},
    }),

  /**
   * Tap-Undo on a clock-in receipt notification → DELETE the entry.
   *
   * Distinct path from a hypothetical generic DELETE /api/timesheets/:id
   * to make the wire-contract intent explicit server-side: this is
   * specifically the "user tapped Undo on the receipt for an
   * auto_geofence entry within ~60 min of clock-in" flow. The
   * backend enforces:
   *   - ownership (entry.userId === session.userId)
   *   - source restriction (entry.source === "auto_geofence")
   *   - 60-min window from entry.clockIn
   * Any of those failing returns 4xx with an explanatory message that
   * the receipt banner surfaces inline.
   *
   * Backend collision note: an existing /api/timesheets/:id route was
   * already in use for other semantics (per Web Agent's diagnosis),
   * which is why the path is `:id/auto-undo` rather than the bare id.
   */
  autoUndoTimeEntry: (entryId: string | number) =>
    apiFetch<void>(`/api/timesheets/${entryId}/auto-undo`, {
      method: "DELETE",
      // Web endpoint returns 204 No Content on success per the
      // standard Express delete pattern. Without this opt, apiFetch
      // would throw "Unexpected non-JSON response" because 204
      // responses have no Content-Type header.
      //
      // S32a-web extension: same endpoint, same method — but for
      // entries that have ALREADY been auto-clocked-out by the
      // server's pending-exit cron, the backend re-opens the entry
      // (clears clock_out) instead of deleting. The wire contract
      // is unchanged from mobile's perspective; the receipt banner's
      // kind="out" Undo path simply calls this method on the same
      // entryId. Server handles routing internally.
      allowEmptyBody: true,
    }),

  // ----- Geofence exit debounce (S32a-mobile) -----

  /**
   * Notify the server that the OS observed a geofence Exit for the
   * user's currently-active auto_geofence session. The server creates
   * a pending exit row and schedules an auto-clock-out 5 minutes from
   * now (server time). Mobile persists the returned `id` + `firesAt`
   * locally via services/pendingExits.ts.
   *
   * Idempotency: server has a partial unique index on
   * pending_geofence_exits WHERE status='pending', so a duplicate
   * POST for the same (timeEntryId, projectId) returns the existing
   * row's id rather than creating a second one. Safe to retry.
   *
   * `detectedAt` is mobile's observation time, NOT the firesAt the
   * server returns. Server uses its own clock for firesAt to avoid
   * clock-skew issues between device and database.
   */
  geofenceExitDetected: (params: {
    projectId: number;
    timeEntryId: string | number;
    detectedAt: string;
  }) =>
    apiFetch<{
      /** Server-issued pending exit row UUID. Becomes pendingExitId locally. */
      id: string;
      /** ISO timestamp when the server cron will fire the auto-clock-out. */
      firesAt: string;
      /** Server-side status; expected "pending" on a successful POST. */
      status: string;
    }>("/api/geofence/exit-detected", {
      method: "POST",
      json: {
        projectId: params.projectId,
        timeEntryId: params.timeEntryId,
        detectedAt: params.detectedAt,
      },
    }),

  /**
   * Cancel a pending exit row before the server cron fires it. Used
   * when the user re-enters the same region within the 5-minute
   * debounce window (i.e. they briefly stepped outside, came back).
   *
   * Mobile only uses the pendingExitId path. The server also accepts
   * a timeEntryId variant per S32a-web spec, but exposing both here
   * with no caller is YAGNI — add the alternate signature only if a
   * future flow needs it.
   *
   * Returns either 204 No Content or a small JSON ack depending on
   * server implementation; allowEmptyBody tolerates either. Caller
   * does not consume the response body — the only signal that
   * matters is "did it throw".
   */
  geofenceExitCancelled: (pendingExitId: string) =>
    apiFetch<void>("/api/geofence/exit-cancelled", {
      method: "POST",
      json: { pendingExitId },
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
};

/** Normalize the various user shapes the backend might return. */
export function normalizeUser(raw: unknown): BackendUser | null {
  if (!raw || typeof raw !== "object") return null;
  const maybeWrapped = raw as { user?: BackendUser };
  const u = (maybeWrapped.user ?? raw) as BackendUser;
  if (!u || typeof u !== "object" || !("email" in u)) return null;
  return u;
}
