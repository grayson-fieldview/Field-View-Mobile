/**
 * Thin API client. All network calls go through here so that the same
 * mobile app can later be pointed at the production backend by setting
 * EXPO_PUBLIC_API_URL (e.g. https://api.yourcompany.com). When no base
 * URL is configured, the app runs fully offline using AsyncStorage.
 */

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? "";

let authToken: string | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}

export function hasRemoteBackend(): boolean {
  return BASE_URL.length > 0;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),

  uploadPhoto: async (
    projectId: string,
    uri: string,
    metadata: Record<string, unknown>,
  ): Promise<{ url: string }> => {
    if (!BASE_URL) throw new Error("No remote backend configured");
    const form = new FormData();
    form.append("projectId", projectId);
    form.append("metadata", JSON.stringify(metadata));
    // React Native FormData file shape
    form.append("file", {
      uri,
      name: `photo-${Date.now()}.jpg`,
      type: "image/jpeg",
    } as unknown as Blob);

    const headers: Record<string, string> = {};
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

    const res = await fetch(`${BASE_URL}/api/photos/upload`, {
      method: "POST",
      body: form,
      headers,
    });
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    return (await res.json()) as { url: string };
  },
};
