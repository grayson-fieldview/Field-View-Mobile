import AsyncStorage from "@react-native-async-storage/async-storage";
import * as TaskManager from "expo-task-manager";

// One-time upgrade cleanup for installs that predate the removal of
// time-tracking. The old geofencing/heartbeat services registered
// OS-level background tasks (iOS geofence regions + Android/iOS
// background location updates) via `defineTask` +
// `startGeofencingAsync` / `startLocationUpdatesAsync`. Deleting the
// JS files does NOT unregister those OS-level tasks — on an upgraded
// install the OS will keep waking the app to dispatch into tasks that
// no longer have a JS body, wasting battery and (on iOS) leaving
// geofence regions monitored forever.
//
// This runs once per install, guarded by an AsyncStorage flag, and
// unregisters ONLY the known legacy task names. It must never crash
// boot: every step is wrapped in try/catch and failures are swallowed
// (the flag is only set on a fully successful pass so a transient
// failure retries on the next launch).

const CLEANUP_FLAG = "@fv/cleanup/geofence_v1";

// Exact task-name string constants used by the removed services,
// recovered from git history:
//   - "fv-geofence-task"  — services/geofencing.ts (startGeofencingAsync)
//   - "fv-heartbeat-task" — services/heartbeat.ts  (startLocationUpdatesAsync)
const LEGACY_TASK_NAMES = ["fv-geofence-task", "fv-heartbeat-task"] as const;

export async function cleanupLegacyBackgroundTasks(): Promise<void> {
  try {
    const done = await AsyncStorage.getItem(CLEANUP_FLAG);
    if (done) return;

    for (const name of LEGACY_TASK_NAMES) {
      try {
        const registered = await TaskManager.isTaskRegisteredAsync(name);
        if (registered) {
          await TaskManager.unregisterTaskAsync(name);
          console.log(`[cleanup] unregistered legacy task: ${name}`);
        }
      } catch (err) {
        // Never let a single task failure crash boot or block the
        // other unregisters. Leave the flag unset so we retry next
        // launch.
        console.log(`[cleanup] failed to unregister ${name}:`, err);
        return;
      }
    }

    await AsyncStorage.setItem(CLEANUP_FLAG, "1");
  } catch (err) {
    // AsyncStorage / TaskManager unavailable (e.g. Expo Go without the
    // native binding). Fail soft — this is best-effort cleanup.
    console.log("[cleanup] legacy task cleanup skipped:", err);
  }
}
