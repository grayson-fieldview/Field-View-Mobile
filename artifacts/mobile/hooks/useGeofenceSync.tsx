import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, type AppStateStatus } from "react-native";

import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/services/api";
import {
  getRegisteredGeofences,
  registerGeofences,
  unregisterAllGeofences,
} from "@/services/geofencing";
import {
  getNotificationPermission,
  notificationOnboardingFlags,
} from "@/services/notifications";
import {
  useLocationPermission,
  type LocationPermissionStatus,
} from "@/services/permissions";

/**
 * Drives the iOS geofence registration lifecycle.
 *
 * Sync triggers (when authenticated AND status === "always-granted"):
 *   - First mount with always-granted status
 *   - Permission status TRANSITIONS into always-granted
 *   - AppState transitions to "active"
 *   - Manual `forceResync()` from the debug surface
 *
 * Unregister triggers:
 *   - Permission status transitions AWAY from always-granted
 *   - User signs out (auth.user becomes null)
 *
 * Debounce:
 *   AppState "active" fires for every backgrounding (lock screen,
 *   notification pull, app switcher peek). The 14-day activity window
 *   doesn't change minute-to-minute, so we skip any sync attempt within
 *   30s of the previous successful sync. `forceResync()` bypasses this.
 *
 * Native module safety:
 *   `services/geofencing` is statically imported here, but its
 *   `expo-task-manager` require() is wrapped in try/catch. On a Dev
 *   Build that lacks the native binding, registerGeofences returns an
 *   error entry instead of throwing — this hook surfaces that as
 *   `error` and never crashes the host tree.
 */

const DEBOUNCE_MS = 30_000;

/**
 * CHECK-ONLY notification-permission status stamp on first successful
 * geofence sync per install. Build 23: this helper NEVER calls
 * requestPermissionsAsync — the onboarding controller in
 * app/(onboarding)/location.tsx is the single owner of the request
 * itself. Kept as a stamping path so the @fv/onboarding/
 * notificationsPrompted flag is always set for users who reach
 * geofence sync (e.g. Build 22 → 23 upgraders who completed the
 * old onboarding before the notifications step existed), so we
 * never accidentally prompt them later.
 *
 * Non-blocking by design: invoked via `void` (no await) from inside
 * sync(). Status read failure must NOT affect geofence registration
 * or retry logic.
 */
async function maybeStampNotificationPromptedFromGeofenceSync(): Promise<void> {
  try {
    const alreadyPrompted = await notificationOnboardingFlags.getPrompted();
    if (alreadyPrompted) return;
    const current = await getNotificationPermission();
    console.log(
      `[notifications] geofence-sync check-only: status=${current} (no prompt issued)`,
    );
  } catch (err) {
    console.log(
      "[notifications] geofence-sync check failed:",
      err instanceof Error ? err.message : err,
    );
  } finally {
    // Stamp REGARDLESS of outcome so subsequent syncs short-circuit.
    try {
      await notificationOnboardingFlags.setPrompted();
    } catch (err) {
      console.log(
        "[notifications] could not stamp prompted flag:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export interface UseGeofenceSyncResult {
  syncing: boolean;
  lastSync: Date | null;
  registeredCount: number;
  error: Error | null;
  /** Manual trigger for the debug surface; bypasses the debounce. */
  forceResync: () => void;
}

function useGeofenceSyncInternal(): UseGeofenceSyncResult {
  const { user, ready: authReady } = useAuth();
  const { status } = useLocationPermission();

  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [registeredCount, setRegisteredCount] = useState<number>(
    () => getRegisteredGeofences().length,
  );
  const [error, setError] = useState<Error | null>(null);

  // Refs so the sync function and AppState callback always read fresh
  // values without re-subscribing every render.
  const lastSyncAtRef = useRef<number>(0);
  const inFlightRef = useRef<boolean>(false);
  const previousStatusRef = useRef<LocationPermissionStatus | null>(null);
  const userIdRef = useRef<string | null>(null);

  const sync = useCallback(
    async (opts: { force?: boolean } = {}): Promise<void> => {
      if (!userIdRef.current) return;
      if (inFlightRef.current) return;

      const now = Date.now();
      if (!opts.force && now - lastSyncAtRef.current < DEBOUNCE_MS) {
        console.log(
          `[geofence] sync skipped: debounced (${now - lastSyncAtRef.current}ms since last)`,
        );
        return;
      }

      inFlightRef.current = true;
      setSyncing(true);
      setError(null);
      try {
        const projects = await api.geofenceEligibleProjects();
        const result = await registerGeofences(projects);
        if (result.errors.length > 0) {
          // First error wins for the surfaced state; full list is in
          // the console log emitted by the service.
          throw new Error(result.errors[0].error);
        }
        lastSyncAtRef.current = Date.now();
        setLastSync(new Date(lastSyncAtRef.current));
        setRegisteredCount(getRegisteredGeofences().length);
        // Fire-and-forget — must NOT block sync return or hold the
        // in-flight guard. See helper docstring for the design
        // rationale (high-intent moment, one-shot, non-blocking).
        void maybeStampNotificationPromptedFromGeofenceSync();
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        console.log("[geofence] sync failed:", wrapped.message);
        setError(wrapped);
      } finally {
        inFlightRef.current = false;
        setSyncing(false);
      }
    },
    [],
  );

  const unregister = useCallback(async (): Promise<void> => {
    try {
      await unregisterAllGeofences();
    } catch (err) {
      console.log("[geofence] unregister failed:", err);
    } finally {
      lastSyncAtRef.current = 0;
      setLastSync(null);
      setRegisteredCount(0);
    }
  }, []);

  // Keep userIdRef in sync; trigger unregister on sign-out.
  // MUST be declared before the delayed-auth-race effect below: that
  // effect calls sync(), which reads userIdRef inside its `!user`
  // guard, and React runs effects in declaration order — so this one
  // has to populate the ref first.
  useEffect(() => {
    const previousUserId = userIdRef.current;
    const nextUserId = user?.id ?? null;
    userIdRef.current = nextUserId;
    if (previousUserId && !nextUserId) {
      void unregister();
    }
  }, [user?.id, unregister]);

  // Cold-launch + delayed-auth race:
  //   If status resolves to "always-granted" BEFORE auth context
  //   loads, the status-transition effect below records the transition
  //   but doesn't sync (no authed user yet). Without this effect, no
  //   first sync ever happens until the user backgrounds + foregrounds
  //   the app — silently broken auto-clock-in for returning users.
  //
  //   `force: true` because this is the equivalent of an initial
  //   mount; it's a delayed-auth race, not a repeated AppState ping.
  //
  //   The status-transition effect won't double-fire here: by the time
  //   auth resolves, previousStatusRef.current is already
  //   "always-granted", so its "previous === status" no-op rule holds.
  useEffect(() => {
    if (!authReady) return;
    if (!user?.id) return;
    if (previousStatusRef.current !== "always-granted") return;
    void sync({ force: true });
  }, [authReady, user?.id, sync]);

  // Status transition handler — the core lifecycle.
  useEffect(() => {
    if (!authReady) return;
    // Skip "loading" entirely; it's the boot transient before we know
    // anything. The permissions hook resolves to a real value within a
    // few frames.
    if (status === "loading") return;

    const previous = previousStatusRef.current;
    previousStatusRef.current = status;

    // First resolved status with always-granted + authed user → sync.
    if (previous === null) {
      if (status === "always-granted" && userIdRef.current) {
        void sync();
      }
      return;
    }

    if (previous === status) return;

    if (status === "always-granted") {
      // Transitioned INTO always-granted (e.g. user upgraded via
      // Settings while app was open). Force-sync — debounce is meant
      // for repeated AppState pings, not user-driven state changes.
      console.log(
        `[geofence] status transition: ${previous} → always-granted, syncing`,
      );
      if (userIdRef.current) void sync({ force: true });
    } else if (previous === "always-granted") {
      // Transitioned AWAY from always-granted. Tear down.
      console.log(
        `[geofence] status transition: always-granted → ${status}, unregistering`,
      );
      void unregister();
    }
  }, [status, authReady, sync, unregister]);

  // AppState "active" → debounced sync (only if currently always-granted
  // and authed). Status changes detected during background→foreground
  // are handled by the status effect above; this handles the case where
  // the projects list itself may have changed server-side.
  useEffect(() => {
    const handleChange = (next: AppStateStatus) => {
      if (next !== "active") return;
      if (!userIdRef.current) return;
      if (previousStatusRef.current !== "always-granted") return;
      void sync();
    };
    const sub = AppState.addEventListener("change", handleChange);
    return () => sub.remove();
  }, [sync]);

  const forceResync = useCallback(() => {
    void sync({ force: true });
  }, [sync]);

  return { syncing, lastSync, registeredCount, error, forceResync };
}

// Context lift: the geofence lifecycle hook owns AppState listeners,
// debounce state, and an in-flight guard. Mounting it twice (e.g. once
// in TabLayoutInner and once in a debug consumer like ProfileScreen)
// would double-subscribe AppState and double-fire force-syncs on
// status transitions. The Provider mounts the internal hook exactly
// once; consumers read the same shared state via `useGeofenceSync()`.
//
// Pattern matches `LocationBannerProvider` from Session 29.

const GeofenceSyncContext = createContext<UseGeofenceSyncResult | null>(null);

export function GeofenceSyncProvider({ children }: { children: ReactNode }) {
  const value = useGeofenceSyncInternal();
  return (
    <GeofenceSyncContext.Provider value={value}>
      {children}
    </GeofenceSyncContext.Provider>
  );
}

export function useGeofenceSync(): UseGeofenceSyncResult {
  const value = useContext(GeofenceSyncContext);
  if (!value) {
    throw new Error(
      "useGeofenceSync must be used inside <GeofenceSyncProvider>",
    );
  }
  return value;
}
