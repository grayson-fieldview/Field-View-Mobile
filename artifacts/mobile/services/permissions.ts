import * as Location from "expo-location";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking, Platform } from "react-native";

import { storage } from "./storage";

/**
 * Location permission service.
 *
 * Wraps expo-location's foreground/background permission APIs and exposes
 * a derived status that maps the two underlying iOS permission states
 * onto a single value the UI can branch on. Re-checks on AppState
 * `"active"` so toggling permission in iOS Settings is reflected without
 * an app restart.
 *
 * iOS-only behaviour notes:
 *   - "Always" requires foreground permission first; iOS shows the Always
 *     upgrade dialog AT MOST ONCE per install. Pre-prompts before each
 *     system dialog are required so we don't waste that one shot.
 *   - The system "Restricted" state (parental controls / MDM) reports as
 *     `denied` in expo-location with `canAskAgain=false`. We surface it
 *     as the separate `"restricted"` status so the UI can avoid showing
 *     a "tap to open Settings" affordance that won't help.
 */

export type LocationPermissionStatus =
  | "loading"
  | "undetermined"
  | "foreground-granted"
  | "always-granted"
  | "denied"
  | "restricted";

export interface UseLocationPermissionResult {
  status: LocationPermissionStatus;
  requestForegroundPermission: () => Promise<LocationPermissionStatus>;
  requestBackgroundPermission: () => Promise<LocationPermissionStatus>;
  openSettings: () => Promise<void>;
}

// --- AsyncStorage flag helpers ---------------------------------------------
// These are NOT exposed via the hook (the hook contract is fixed at
// status + 3 actions). The onboarding screen reads/writes them directly.

const PREPROMPTED_KEY = "@fv/onboarding/preprompted";
const UPGRADE_SHOWN_KEY = "@fv/onboarding/locationUpgradeShown";

export const locationOnboardingFlags = {
  getPreprompted: () => storage.getFlag(PREPROMPTED_KEY),
  setPreprompted: () => storage.setFlag(PREPROMPTED_KEY, true),
  getUpgradeShown: () => storage.getFlag(UPGRADE_SHOWN_KEY),
  setUpgradeShown: () => storage.setFlag(UPGRADE_SHOWN_KEY, true),
};

// --- AppState-refresh suppression for in-flight permission prompts ---------
//
// Build 23: iPad churn. When iOS shows or dismisses a permission
// dialog, the host app transitions inactive → active multiple times
// in rapid succession (much more aggressively than iPhone). Each
// such transition fires the AppState listener below, which calls
// readCurrentStatus() and mutates `status`. The onboarding screen
// previously re-derived its phase from `status`, so iPad's dialog
// churn would reset the phase mid-flow and reopen prompts — the
// loop App Review rejected Build 22 for.
//
// The onboarding screen now owns its phase explicitly (per step
// handler) and brackets each request*PermissionsAsync await with
// beginPermissionRequest() / endPermissionRequest(). While in
// flight (and for a brief grace window after) the AppState→active
// refresh is suppressed, so status remains stable from the moment
// a dialog opens through its dismissal. AuthGate's
// `needsOnboarding` is a function of `locationStatus`, so freezing
// `locationStatus` also prevents AuthGate from re-evaluating
// routing while a request modal is up.
//
// Counter is intentionally module-scoped (the hook is mounted in
// multiple places: AuthGate + the onboarding screen + tabs; any
// consumer of useLocationPermission must respect the same gate).
let permissionRequestsInFlight = 0;
let suppressActiveUntilMs = 0;
const POST_REQUEST_GRACE_MS = 750;

export function beginPermissionRequest(): void {
  permissionRequestsInFlight += 1;
}

export function endPermissionRequest(): void {
  permissionRequestsInFlight = Math.max(0, permissionRequestsInFlight - 1);
  // Grace window absorbs the dialog-dismiss inactive→active event
  // that fires AFTER the request promise resolves on iPad.
  suppressActiveUntilMs = Date.now() + POST_REQUEST_GRACE_MS;
}

function isActiveRefreshSuppressed(): boolean {
  return (
    permissionRequestsInFlight > 0 || Date.now() < suppressActiveUntilMs
  );
}

// --- Status derivation -----------------------------------------------------

/**
 * Combine the foreground + background permission responses from
 * expo-location into a single status value. iOS reports background as
 * `undetermined` until the user has been through the Always upgrade
 * flow, even when foreground is granted — treat that as
 * `foreground-granted`, NOT `always-granted`.
 */
function deriveStatus(
  fg: Location.PermissionResponse,
  bg: Location.PermissionResponse,
): LocationPermissionStatus {
  if (
    fg.status === Location.PermissionStatus.DENIED &&
    fg.canAskAgain === false
  ) {
    // NOTE: DENIED + canAskAgain=false is NOT a precise restricted signal.
    // iOS reports the same shape after a normal user deny (the system only
    // shows the prompt once). Without a native CLAuthorizationStatus bridge
    // we can't tell parental-controls/MDM apart from post-deny, so we err
    // toward "restricted" here and accept that some post-deny users will
    // see the no-Settings-link copy. Revisit if/when we add a native bridge.
    return "restricted";
  }
  if (fg.status === Location.PermissionStatus.DENIED) return "denied";
  if (fg.status === Location.PermissionStatus.UNDETERMINED) {
    return "undetermined";
  }
  // Foreground is GRANTED — check background.
  if (bg.status === Location.PermissionStatus.GRANTED) return "always-granted";
  return "foreground-granted";
}

async function readCurrentStatus(): Promise<LocationPermissionStatus> {
  try {
    const [fg, bg] = await Promise.all([
      Location.getForegroundPermissionsAsync(),
      Location.getBackgroundPermissionsAsync(),
    ]);
    return deriveStatus(fg, bg);
  } catch {
    // Treat any native-side failure as undetermined; the next prompt
    // attempt will surface a real error to the caller.
    return "undetermined";
  }
}

// --- Hook ------------------------------------------------------------------

export function useLocationPermission(): UseLocationPermissionResult {
  // Start in `loading` so AuthGate doesn't redirect on the synchronous
  // first render before we've actually queried the OS.
  const [status, setStatus] = useState<LocationPermissionStatus>("loading");
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const next = await readCurrentStatus();
    if (mountedRef.current) setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    // Re-check whenever the app comes back to the foreground; the user
    // may have toggled the setting in iOS Settings while we were in the
    // background.
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      if (isActiveRefreshSuppressed()) {
        // Onboarding has a permission dialog in flight (or just
        // dismissed one). Skipping the refresh keeps `status` stable
        // so the onboarding controller's phase machine isn't
        // perturbed and AuthGate doesn't re-route mid-flow.
        console.log(
          "[permissions] AppState→active refresh suppressed: request in flight",
        );
        return;
      }
      refresh();
    });
    return () => {
      mountedRef.current = false;
      sub.remove();
    };
  }, [refresh]);

  const requestForegroundPermission = useCallback(async () => {
    try {
      await Location.requestForegroundPermissionsAsync();
    } catch {
      /* fall through to refresh — read the resulting state below */
    }
    return refresh();
  }, [refresh]);

  const requestBackgroundPermission = useCallback(async () => {
    try {
      await Location.requestBackgroundPermissionsAsync();
    } catch {
      /* fall through to refresh */
    }
    return refresh();
  }, [refresh]);

  const openSettings = useCallback(async () => {
    if (Platform.OS === "ios") {
      await Linking.openURL("app-settings:");
    } else {
      // Android — `openSettings` opens the app's settings page; safe
      // no-op enabler for the future Phase 3 Android port.
      await Linking.openSettings();
    }
  }, []);

  return {
    status,
    requestForegroundPermission,
    requestBackgroundPermission,
    openSettings,
  };
}
