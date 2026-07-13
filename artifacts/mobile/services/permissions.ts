import * as Location from "expo-location";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking, Platform } from "react-native";

/**
 * Location permission service.
 *
 * Wraps expo-location's foreground permission API and exposes a
 * derived status the UI can branch on. Re-checks on AppState
 * `"active"` so toggling permission in iOS Settings is reflected
 * without an app restart.
 *
 * iOS-only behaviour note:
 *   - The system "Restricted" state (parental controls / MDM) reports
 *     as `denied` in expo-location with `canAskAgain=false`. We surface
 *     it as the separate `"restricted"` status so the UI can avoid
 *     showing a "tap to open Settings" affordance that won't help.
 */

export type LocationPermissionStatus =
  | "loading"
  | "undetermined"
  | "foreground-granted"
  | "denied"
  | "restricted";

export interface UseLocationPermissionResult {
  status: LocationPermissionStatus;
  requestForegroundPermission: () => Promise<LocationPermissionStatus>;
  openSettings: () => Promise<void>;
}

// --- Status derivation -----------------------------------------------------

/**
 * Map the foreground permission response from expo-location into a
 * single status value.
 */
function deriveStatus(
  fg: Location.PermissionResponse,
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
  return "foreground-granted";
}

async function readCurrentStatus(): Promise<LocationPermissionStatus> {
  try {
    const fg = await Location.getForegroundPermissionsAsync();
    return deriveStatus(fg);
  } catch {
    // Treat any native-side failure as undetermined; the next prompt
    // attempt will surface a real error to the caller.
    return "undetermined";
  }
}

// --- Hook ------------------------------------------------------------------

export function useLocationPermission(): UseLocationPermissionResult {
  // Start in `loading` so consumers don't redirect on the synchronous
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

  const openSettings = useCallback(async () => {
    if (Platform.OS === "ios") {
      await Linking.openURL("app-settings:");
    } else {
      await Linking.openSettings();
    }
  }, []);

  return {
    status,
    requestForegroundPermission,
    openSettings,
  };
}
