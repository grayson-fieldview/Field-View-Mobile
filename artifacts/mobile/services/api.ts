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
      `[boot] keychain read fv_session_cookies = "${raw.slice(0, 30)}…" (len=${raw.length})`,
    );
  }
  console.log("[cookie-migration] loaded from storage:", raw);
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
  console.log("[cookie-migration] after dedup:", cleaned);
  console.log("[cookie-migration] differs:", raw !== cleaned);
  const snap = debugCookieSnapshot();
  console.log(
    `[boot] cookieJar size = ${snap.size}, names = [${snap.names.join(", ")}]`,
  );
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
  const serialized = serializeCookieJar();
  secureStorage
    .setItem(COOKIE_STORAGE_KEY, serialized)
    .then(() => {
      console.log(
        `[login] keychain write = SUCCESS (len=${serialized.length})`,
      );
    })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[login] keychain write = FAILED: ${msg}`);
    });
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
  console.log("[cookie-outgoing]", headers["Cookie"]);

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
      `[boot] me() Cookie header being sent = "${(headers["Cookie"] ?? "").slice(0, 60)}…" (len=${(headers["Cookie"] ?? "").length})`,
    );
    console.log(
      "[boot] me() X-FieldView-Client header =",
      headers["X-FieldView-Client"] ?? "(MISSING)",
    );
  }

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
    if (traceTag === "[boot]") {
      console.log("[boot] me() response status =", res.status);
      console.log(
        "[boot] me() response Set-Cookie present =",
        setCookieHeader ? "yes" : "no",
      );
    }
    if (traceTag === "[login]") {
      console.log(
        `[login] response Set-Cookie raw = ${setCookieHeader ? `"${setCookieHeader.slice(0, 120)}…"` : "(none)"}`,
      );
      // Peek the jar AFTER parseAndPersistSetCookie runs below.
      // We can't snapshot here (parsing happens after this block);
      // see the snapshot just past the `parseAndPersistSetCookie`
      // call.
    }
  } catch (e) {
    throw new ApiError(
      0,
      `Network request failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Capture any new/rotated session cookies.
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) parseAndPersistSetCookie(setCookie);
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
   * Soft-delete marker from /api/users. Non-null means the user has been
   * deactivated and should be filtered out of any "pick a teammate" UI.
   */
  deletedAt?: string | null;
  /**
   * Auto clock-in/out master switch (S33). Server is authoritative.
   * Mobile mirrors to AsyncStorage via services/preferences so the
   * geofence background task (which has no React context) can read it.
   * Default true on null/missing — see toAuthUser() in AuthContext.
   */
  autoTrackingEnabled?: boolean;
  [key: string]: unknown;
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
  caption?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  tags?: string[] | null;
  createdAt: string;
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

// ----- Reports (Mobile Reports R1, 2026-05) -----
//
// Read + write surface for the report builder. Mobile can list, create
// (blank or from template), edit metadata, author sections, attach +
// detach project photos, edit photo captions, and trigger server-side
// PDF generation. Template AUTHORING is web-only — mobile only picks
// from existing report_templates rows. All field names are camelCase
// to match the wire format.

export type ReportStatus = "draft" | "submitted" | "approved";

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

/**
 * Response from POST /api/projects/:id/share. Server mints (or
 * returns the existing) public share token for the project. The
 * recipient-facing URL is `https://app.field-view.com/p/<token>`.
 */
export interface BackendShareTokenResponse {
  shareToken: string;
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

  geofenceEligibleProjects: () =>
    apiFetch<BackendGeofenceEligibleProject[]>(
      "/api/projects/geofence-eligible",
    ),

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

  /** Revoke the current public share token. Server returns 204. */
  unshareProject: (projectId: string | number) =>
    apiFetch<void>(`/api/projects/${projectId}/share`, {
      method: "DELETE",
      allowEmptyBody: true,
    }),

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

  // ----- Geofence enter dwell-time (S3x-mobile) -----

  /**
   * Notify the server that the OS observed a geofence Enter for a
   * region the user is *not* yet clocked into. The server creates
   * a pending enter row and schedules an auto-clock-in N seconds
   * from now (server-side AUTO_CLOCK_IN_DWELL_MS, currently 60s
   * but mobile never reads or hardcodes the value — `firesAt` in
   * the response is the source of truth).
   *
   * Idempotency: server has a partial unique index on
   * pending_geofence_enters WHERE status='pending', so a duplicate
   * POST for the same (userId, projectId) returns the existing
   * row's id rather than creating a second one (response 200 with
   * status="pending"). Safe to retry.
   *
   * Already-clocked-in short-circuit: server returns
   * { status: "skipped", reason: "already_clocked_in" } when the
   * user already has an active session. Mobile must NOT persist a
   * local row in that case — there's nothing to cancel and nothing
   * to discover post-facto.
   *
   * `detectedAt` is mobile's observation time, NOT the firesAt the
   * server returns. Server uses its own clock for firesAt to avoid
   * clock-skew issues between device and database.
   *
   * `regionId` is optional per the wire contract but mobile always
   * sends it (we always know it from the OS event) — helps server-
   * side observability and matches how the rest of geofencing.ts
   * threads regionId through every step.
   */
  geofenceEnterDetected: (params: {
    projectId: number;
    regionId?: string;
    detectedAt: string;
  }) =>
    apiFetch<
      | {
          /** Server-issued pending enter row UUID. Becomes pendingEnterId locally. */
          id: string;
          /** ISO timestamp when the server cron will fire the auto-clock-in. */
          firesAt: string;
          status: "pending";
        }
      | {
          status: "skipped";
          reason: string;
        }
    >("/api/geofence/enter-detected", {
      method: "POST",
      json: {
        projectId: params.projectId,
        regionId: params.regionId,
        detectedAt: params.detectedAt,
      },
    }),

  /**
   * Cancel a pending enter row before the server cron fires it. Used
   * when the user steps off the site within the dwell window
   * (i.e. the OS fires Exit for a region we have a pending enter for).
   *
   * Mobile only uses the pendingEnterId path. Server returns a small
   * JSON ack `{ id, status: "cancelled" }`; mobile does not consume
   * the response body — the only signal that matters is "did it
   * throw". Mirror of geofenceExitCancelled.
   */
  geofenceEnterCancelled: (pendingEnterId: string) =>
    apiFetch<{ id: string; status: "cancelled" }>(
      "/api/geofence/enter-cancelled",
      {
        method: "POST",
        json: { pendingEnterId },
      },
    ),

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
   * the geofence-exit cron can deliver clock_out_receipt pushes.
   * Server returns 204 on success. Wire-only — caller is responsible
   * for capturing the token via expo-notifications first.
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

  /**
   * Update one or more user preferences. Currently only autoTrackingEnabled
   * (S33 master switch for OS-driven clock in/out). Server returns the
   * full updated BackendUser so callers can replace their local copy in
   * one shot rather than reconciling fields.
   */
  updatePreferences: (input: { autoTrackingEnabled?: boolean }) =>
    apiFetch<BackendUser>("/api/users/me/preferences", {
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

  // ----- Team / invitations (web rework, 2026-05) -----

  /**
   * All users in the caller's account (active + soft-deleted; includes
   * the caller themselves). Used by the "Add user to project" picker —
   * the caller is responsible for filtering out self, soft-deleted
   * (deletedAt != null), and users already on the target project.
   */
  listAccountUsers: () => apiFetch<BackendUser[]>("/api/users"),

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
  attachPhotoToItem: (itemId: string | number, mediaId: number) =>
    apiFetch<BackendChecklistItemPhoto>(
      `/api/checklist-items/${itemId}/photos`,
      { method: "POST", json: { mediaId } },
    ),

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
  applyChecklistTemplate: (
    projectId: string | number,
    templateId: string | number,
  ) =>
    apiFetch<BackendChecklist>(`/api/projects/${projectId}/checklists`, {
      method: "POST",
      json: { templateId },
    }),

  // ----- Reports (Mobile Reports R1) -----
  // DELETE endpoints in this group return 200 + body `{message: "Deleted"}`
  // (NOT 204 — that's the tasks endpoint's contract). `allowEmptyBody`
  // is set so that if the server is upgraded to 204 in the future, the
  // mobile call keeps working without code changes.

  /** Project-scoped list of report rows (no sections / no photos). */
  listReportsForProject: (projectId: string | number) =>
    apiFetch<BackendReport[]>(`/api/projects/${projectId}/reports`),

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
      throw new ApiError(
        0,
        `Network request failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) parseAndPersistSetCookie(setCookie);
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
