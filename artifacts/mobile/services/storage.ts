import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
  Photo,
  Project,
  User,
} from "./types";

const KEYS = {
  user: "@fv/user",
  authToken: "@fv/token",
  // Bumped to v2 to recover from a bug where loadProjectDetail wrote a
  // truncated projects array (only the just-viewed project + local-only
  // rows) into AsyncStorage. v1 caches are orphaned on next launch and
  // re-hydrated empty so the auth-ready force-refresh repopulates from
  // the server. Safe to delete the cleanup below after a release or two.
  projects: "@fv/projects/v2",
  photos: "@fv/photos",
  // Preferences. Read/written directly by services/preferences.ts
  // (tri-state, can't use the binary getFlag/setFlag wrappers below).
  // Listed here to keep the @fv/ namespace registry in one place.
  prefs_autoTracking: "@fv/prefs/autoTracking",
} as const;

// Orphaned cache keys to remove on every app start. `@fv/shares` is the
// dropped fake-share-link cache from the pre-real-invites era;
// `@fv/checklists` is the dropped local-only AsyncStorage checklist cache
// replaced by the v2 server-backed checklists in 2026-05; `@fv/tasks` is
// the dropped local-only AsyncStorage task cache replaced by the v2
// server-backed tasks (assigned_to_id) in 2026-05. Leave all three in
// this list for a release or two so existing installs purge them.
const LEGACY_KEYS = [
  "@fv/projects",
  "@fv/shares",
  "@fv/checklists",
  "@fv/tasks",
] as const;

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson<T>(key: string, value: T): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

export const storage = {
  // Session
  getUser: () => readJson<User | null>(KEYS.user, null),
  setUser: (u: User | null) =>
    u ? writeJson(KEYS.user, u) : AsyncStorage.removeItem(KEYS.user),

  getToken: () => AsyncStorage.getItem(KEYS.authToken),
  setToken: (t: string | null) =>
    t ? AsyncStorage.setItem(KEYS.authToken, t) : AsyncStorage.removeItem(KEYS.authToken),

  // Data
  getProjects: () => readJson<Project[]>(KEYS.projects, []),
  setProjects: (p: Project[]) => writeJson(KEYS.projects, p),

  getPhotos: () => readJson<Photo[]>(KEYS.photos, []),
  setPhotos: (p: Photo[]) => writeJson(KEYS.photos, p),

  // Tasks intentionally have no get/set helpers — they are server-only
  // since the v2 rewrite (2026-05). The legacy @fv/tasks key is purged
  // by pruneLegacyKeys() on every app start.

  clearSession: async () => {
    await AsyncStorage.multiRemove([KEYS.user, KEYS.authToken]);
  },

  /** Best-effort cleanup of orphaned cache keys from previous schema versions. */
  pruneLegacyKeys: async () => {
    try {
      await AsyncStorage.multiRemove(LEGACY_KEYS as unknown as string[]);
    } catch {
      /* ignore */
    }
  },

  // Generic boolean flag helpers. Used by ad-hoc onboarding/feature flags
  // (e.g. location pre-prompt tracking) that don't warrant a dedicated
  // typed accessor. Stored as the literal strings "1" / absent.
  getFlag: async (key: string): Promise<boolean> => {
    try {
      return (await AsyncStorage.getItem(key)) === "1";
    } catch {
      return false;
    }
  },
  setFlag: async (key: string, value: boolean): Promise<void> => {
    try {
      if (value) await AsyncStorage.setItem(key, "1");
      else await AsyncStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};
