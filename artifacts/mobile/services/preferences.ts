import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Auto clock-in/out master switch (S33).
 *
 * Mirror of the server-authoritative `users.autoTrackingEnabled`
 * field. Written by AuthContext on every successful refresh + on
 * user-driven toggle. Read by the geofence background task
 * (services/geofencing.ts) at the top of handleGeofenceEnter and
 * handleGeofenceExit — those run via TaskManager.defineTask outside
 * the React tree, so AuthContext is unreachable. AsyncStorage is
 * the only correct cross-runtime source.
 *
 * Default true on missing: a fresh install with no key has NOT
 * opted out. Re-installing the app (nukes AsyncStorage) should not
 * silently disable a feature the user previously had on; the next
 * AuthContext refresh will re-mirror the server value within
 * seconds.
 *
 * Why direct AsyncStorage instead of storage.getFlag/setFlag: those
 * helpers are two-state (present="1" / absent), which conflates
 * "explicitly false" with "never set" and breaks our default-true
 * contract. We need tri-state: "1" = on, "0" = off, null = unset.
 * The KEY is still listed in storage.ts KEYS as the canonical @fv/
 * namespace registry entry.
 */
const AUTO_TRACKING_KEY = "@fv/prefs/autoTracking";

export const autoTrackingPref = {
  get: async (): Promise<boolean> => {
    try {
      const raw = await AsyncStorage.getItem(AUTO_TRACKING_KEY);
      return raw !== "0";
    } catch {
      // AsyncStorage failure: fail-open (auto-tracking on). The next
      // successful AuthContext refresh will rewrite from server truth.
      return true;
    }
  },
  set: async (enabled: boolean): Promise<void> => {
    try {
      await AsyncStorage.setItem(AUTO_TRACKING_KEY, enabled ? "1" : "0");
    } catch {
      /* best-effort mirror; server is authoritative */
    }
  },
};
