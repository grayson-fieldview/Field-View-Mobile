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
 * platforms we parse Set-Cookie from login/register responses, persist
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

export interface BackendProjectDetail {
  project: BackendProject;
  media?: BackendMedia[];
  tasks?: BackendTask[];
  checklists?: unknown[];
  reports?: unknown[];
}

// ----- Endpoint wrappers -----
export const api = {
  base: API_BASE_URL,

  login: (email: string, password: string) =>
    apiFetch<BackendUser | { user: BackendUser } | null>("/api/login", {
      method: "POST",
      json: { email, password },
    }),

  register: (data: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
  }) =>
    apiFetch<BackendUser | { user: BackendUser } | null>("/api/register", {
      method: "POST",
      json: data,
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

  tasks: () => apiFetch<BackendTask[]>("/api/tasks"),

  uploadPhoto: async (
    projectId: string,
    uri: string,
    metadata: Record<string, unknown>,
  ): Promise<{ url: string }> => {
    if (!API_BASE_URL) throw new ApiError(0, "No API base URL configured");
    if (!loaded) await loadSession();
    const form = new FormData();
    form.append("projectId", projectId);
    form.append("metadata", JSON.stringify(metadata));
    form.append("file", {
      uri,
      name: `photo-${Date.now()}.jpg`,
      type: "image/jpeg",
    } as unknown as Blob);

    const headers: Record<string, string> = {};
    if (cookieJar.size > 0 && Platform.OS !== "web") headers["Cookie"] = serializeCookieJar();

    console.log("[api] Cookie being sent:", headers["Cookie"] || "(none)");
    const res = await fetch(`${API_BASE_URL}/api/photos/upload`, {
      method: "POST",
      body: form,
      headers,
      credentials: Platform.OS === "web" ? "include" : "omit",
    });
    const sc = res.headers.get("set-cookie");
    if (sc) console.log("[api] Set-Cookie received:", sc);
    if (sc) parseAndPersistSetCookie(sc);
    if (!res.ok) throw new ApiError(res.status, `Upload failed (${res.status})`);
    return (await res.json()) as { url: string };
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
