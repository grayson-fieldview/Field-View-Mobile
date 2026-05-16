import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as Location from "expo-location";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTimesheet } from "@/contexts/TimesheetContext";
import { useColors } from "@/hooks/useColors";
import { ApiError, api } from "@/services/api";
import {
  DEFAULT_GEOFENCE_RADIUS_M,
  getRegisteredRegions,
  haversineMeters,
} from "@/services/geofencing";
import { removePendingEnterById } from "@/services/pendingEnters";

/**
 * BUILD 13 / Diff 2: top-level pending-enter countdown banner.
 *
 * Lifecycle:
 *   1. The geofence task body (or the inside-check) POSTs
 *      /api/geofence/enter-detected and persists a pending-enter row
 *      in pendingEnters.ts with the server-issued `firesAt`.
 *   2. pendingEnters.ts emits `fv:pending-enter-changed`.
 *      TimesheetContext re-derives `pendingEnter` from
 *      `listPendingEnters()` and sets state.
 *   3. This banner reads `pendingEnter` + `active` from context.
 *      Renders when `pendingEnter != null && active == null`.
 *      Counts down MM:SS every second.
 *   4. At zero: re-verifies location (one-shot, Balanced, 5s timeout)
 *      and POSTs `/api/geofence/fire-now` (if still inside) or
 *      `/api/geofence/enter-cancelled` (if moved away).
 *   5. Either response → remove local pending row → broadcast →
 *      `pendingEnter` becomes null → banner unmounts.
 *
 * Cold-launch with expired `firesAt`: the first interval tick clamps
 * `secondsRemaining` to 0 and triggers the fire path immediately. No
 * special cold-launch branch needed.
 *
 * Mounted at app root inside AuthGate (app/_layout.tsx), so it
 * persists across screen navigations. Mutually-exclusive with
 * ClockReceiptBanner by scope: ClockReceipt is only ever mounted
 * inside the project detail screen and only renders after a fire has
 * already happened. When fire-now succeeds here, TimesheetContext
 * updates `active` (via refresh), this banner unmounts, and
 * ClockReceiptBanner takes over on the project detail screen if the
 * user navigates there.
 *
 * Visual treatment: information-grade pill (matches ClockReceiptBanner
 * neutral aesthetic), distinguishable by the live countdown body.
 * Top-anchored with safe-area inset padding so it sits below the
 * notch / Dynamic Island without overlapping the status bar.
 */

/**
 * Buffer added to DEFAULT_GEOFENCE_RADIUS_M when re-verifying at fire
 * time. The Enter event fires at ~150m; by dwell expiry the user
 * may have drifted to the edge of the radius (or be standing at it
 * with GPS jitter). The +50m buffer accommodates accuracy noise so
 * we don't false-cancel a user who's legitimately on-site. Mirrors
 * geofencing.ts PROXIMITY_THRESHOLD_M (200m) for symmetry with the
 * task-body filter chain.
 */
const FIRE_VERIFY_BUFFER_M = 50;

/**
 * Wall-clock cap on the re-verify location fix. Mirrors the inside-
 * check timeout for the same reason: expo-location's `timeout` field
 * is advisory on iOS, and we'd rather fall through to "cancel" than
 * block on a hanging GPS chip.
 */
const RE_VERIFY_TIMEOUT_MS = 5_000;

function formatRemaining(secondsRemaining: number): string {
  const s = Math.max(0, Math.floor(secondsRemaining));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${ss.toString().padStart(2, "0")}`;
}

export function PendingEnterBanner(): React.JSX.Element | null {
  const { pendingEnter, active, refresh } = useTimesheet();
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();

  // Captured per-mount so the banner survives parent re-renders. We
  // recompute every tick from the live `pendingEnter.firesAt`
  // (rather than storing the deadline once) so that if the same
  // pendingEnter row is updated server-side with a new firesAt
  // mid-dwell, the countdown picks it up on the next tick.
  const [now, setNow] = useState<number>(() => Date.now());

  // Reentrancy guard. setInterval can fire the zero-tick path twice
  // if the JS thread is briefly stalled (e.g. an Android GC pause)
  // and two ticks land within the same loop iteration. Once we've
  // committed to firing, ignore further ticks until the row is
  // removed and the banner unmounts.
  const firingRef = useRef<boolean>(false);

  // Cancel-button in-flight indicator. Suppresses the spinner from
  // sticking around if the user dismisses while a re-verify is also
  // in flight (unlikely race but cheap to handle).
  const [cancelling, setCancelling] = useState<boolean>(false);

  // Drive the countdown. setInterval is intentional (not
  // requestAnimationFrame): we only update once per second, the
  // banner doesn't animate visually between ticks, and rAF would
  // pause when the app is backgrounded — exactly the wrong behavior
  // since we want the countdown to keep advancing.
  useEffect(() => {
    if (!pendingEnter) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pendingEnter]);

  // Reset the firing guard whenever the pending row changes
  // identity. Without this, switching from one pending enter to
  // another (rare but possible — different project) would keep
  // the guard set and skip the fire on the new row.
  useEffect(() => {
    firingRef.current = false;
  }, [pendingEnter?.pendingEnterId]);

  // Compute remaining each render — cheap, and avoids stale state
  // bugs from caching the value in a separate piece of useState.
  const firesAtMs = pendingEnter ? Date.parse(pendingEnter.firesAt) : null;
  const secondsRemaining =
    firesAtMs != null && Number.isFinite(firesAtMs)
      ? Math.max(0, (firesAtMs - now) / 1000)
      : 0;

  // Fire-trigger effect. Watches `secondsRemaining`; when it hits 0
  // and we haven't already fired, kick the verify-then-fire flow.
  useEffect(() => {
    if (!pendingEnter) return;
    if (firingRef.current) return;
    if (secondsRemaining > 0) return;
    if (pendingEnter.pendingEnterId == null) {
      // Unsent retry row — no server-side id to fire against. The
      // TimesheetContext unsent-retry path will re-POST enter-
      // detected on next foreground; this banner just waits.
      return;
    }

    firingRef.current = true;
    const pendingEnterId = pendingEnter.pendingEnterId;
    const projectId = pendingEnter.projectId;

    void (async () => {
      try {
        // ---- Re-verify the user is still on-site ----
        // If they walked away during dwell, cancel instead of fire.
        // Falls back to "fire anyway" if location fails to fetch in
        // time — better to clock them in (with undo available) than
        // miss a legitimate arrival on a flaky GPS read.
        let stillInside = true;
        const region = getRegisteredRegions().find(
          (r) => r.project.id === projectId,
        );
        if (region) {
          try {
            const pos = await Promise.race([
              Location.getCurrentPositionAsync({
                accuracy: Location.Accuracy.Balanced,
              }),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error("location timeout")),
                  RE_VERIFY_TIMEOUT_MS,
                ),
              ),
            ]);
            const distance = haversineMeters(pos.coords, {
              latitude: region.project.latitude,
              longitude: region.project.longitude,
            });
            stillInside =
              distance <= DEFAULT_GEOFENCE_RADIUS_M + FIRE_VERIFY_BUFFER_M;
            console.log(
              `[pending-enter-banner] re-verify: distance=${Math.round(distance)}m stillInside=${stillInside}`,
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.log(
              `[pending-enter-banner] re-verify location failed (${msg}); proceeding with fire (charitable default)`,
            );
          }
        } else {
          console.log(
            `[pending-enter-banner] no registered region for projectId=${projectId}; proceeding with fire`,
          );
        }

        // ---- Fire or cancel ----
        if (stillInside) {
          try {
            await api.geofenceFireNow(pendingEnterId);
            console.log(
              `[pending-enter-banner] fire-now ok: pendingEnterId=${pendingEnterId}`,
            );
          } catch (e) {
            // Silent fallback to cron. 404/409/410 are expected
            // benign races; network errors are tolerable because
            // the cron will still sweep the row server-side.
            const status = e instanceof ApiError ? e.status : null;
            const msg = e instanceof Error ? e.message : String(e);
            console.log(
              `[pending-enter-banner] fire-now failed (status=${status ?? "?"}): ${msg} — cron fallback`,
            );
          }
          // ORDER MATTERS: refresh BEFORE removing the local row.
          //
          // TimesheetContext's post-facto discovery (inside refresh)
          // only sets `firedEnter` — the surface that drives the
          // kind="in" ClockReceiptBanner on the project screen —
          // when it can MATCH the freshly-fired active session
          // against a pending-enter row in `listPendingEnters()`
          // (by projectId). If we removed the row first, the match
          // would fail and the user would silently lose the receipt
          // (no Undo affordance). Architect-caught regression.
          //
          // Awaiting refresh() guarantees the discovery has run AND
          // already called `removePendingEntersByProjectId` itself,
          // so our subsequent removePendingEnterById is a redundant
          // safety net (idempotent — no-op if already gone). The
          // safety net matters if the server hadn't yet committed
          // the new active row when we polled (rare 201-then-GET
          // race) — in that case the row is still here and we
          // ensure cleanup so the banner doesn't get stuck.
          await refresh();
          await removePendingEnterById(pendingEnterId);
        } else {
          // Moved away during dwell — cancel cleanly. Mirrors the
          // Exit-handler cancel path in geofencing.ts; same
          // endpoint, same teardown.
          try {
            await api.geofenceEnterCancelled(pendingEnterId);
            console.log(
              `[pending-enter-banner] cancel ok: pendingEnterId=${pendingEnterId}`,
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.log(
              `[pending-enter-banner] cancel failed: ${msg} (removing local row anyway)`,
            );
          }
          await removePendingEnterById(pendingEnterId);
        }
      } catch (e) {
        // Outermost catch — anything that escaped the inner
        // handlers. Always remove the local row to avoid a stuck
        // banner. The firingRef stays true, but pendingEnter going
        // null via the emit will trigger the identity-change effect
        // above which resets it.
        const msg = e instanceof Error ? e.message : String(e);
        console.log(
          `[pending-enter-banner] unexpected fire error: ${msg} (clearing local row)`,
        );
        try {
          await removePendingEnterById(pendingEnterId);
        } catch {
          // give up silently
        }
      }
    })();
  }, [pendingEnter, secondsRemaining, refresh]);

  // ---- Render gates ----
  // Hide when already clocked in (the post-facto discovery path or
  // the fire path will clear pendingEnter via emit shortly). Hide on
  // the unsent-retry state (no pendingEnterId means no server row to
  // cancel/fire; the retry path owns it).
  if (!pendingEnter) return null;
  if (active != null) return null;
  if (pendingEnter.pendingEnterId == null) return null;

  const projectLabel =
    getRegisteredRegions().find((r) => r.project.id === pendingEnter.projectId)
      ?.project.name ?? "this site";

  const remainingLabel = formatRemaining(secondsRemaining);

  const onCancelPress = async () => {
    if (cancelling) return;
    // Mutual-exclusion with the auto-fire effect (architect-caught
    // race). If the user taps Cancel within the last second of
    // countdown, setInterval can still tick to zero and the fire
    // effect can race the cancel POST. Claim firingRef here so the
    // effect's `if (firingRef.current) return` early-out trips
    // immediately — cancel wins the race deterministically.
    // Order vs setCancelling: ref-set first (synchronous, no
    // re-render needed) so even a microtask-scheduled tick that
    // wins the JS turn still sees the claim.
    if (firingRef.current) return;
    firingRef.current = true;
    setCancelling(true);
    const id = pendingEnter.pendingEnterId;
    if (id == null) {
      setCancelling(false);
      return;
    }
    try {
      try {
        await api.geofenceEnterCancelled(id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(
          `[pending-enter-banner] manual cancel POST failed: ${msg} (removing local row anyway)`,
        );
      }
      await removePendingEnterById(id);
    } finally {
      setCancelling(false);
    }
  };

  const onBodyPress = () => {
    router.push({
      pathname: "/project/[id]",
      params: { id: String(pendingEnter.projectId) },
    });
  };

  // We render whether or not we're firing — at expiry we want the
  // banner to show "0:00" (or "Clocking in…") for a beat before
  // pendingEnter clears via emit. Avoids a jarring instant-vanish.
  const isAtZero = secondsRemaining <= 0;

  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel={`Auto-clock-in to ${projectLabel} in ${remainingLabel}`}
      pointerEvents="box-none"
      style={[
        styles.outer,
        {
          paddingTop: insets.top + 8,
        },
      ]}
    >
      <Pressable
        onPress={onBodyPress}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.wrap,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            shadowColor: "#000",
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <View style={styles.row}>
          <View style={styles.iconWrap}>
            {isAtZero ? (
              <ActivityIndicator size="small" color={colors.mutedForeground} />
            ) : (
              <Feather
                name="map-pin"
                size={18}
                color={colors.mutedForeground}
              />
            )}
          </View>
          <View style={styles.body}>
            <Text
              style={[styles.bodyTxt, { color: colors.foreground }]}
              numberOfLines={1}
            >
              {isAtZero
                ? `Clocking in to ${projectLabel}…`
                : `Auto-clock-in to ${projectLabel} in ${remainingLabel}`}
            </Text>
          </View>
          <Pressable
            onPress={onCancelPress}
            disabled={cancelling || isAtZero}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Cancel auto-clock-in"
            style={({ pressed }) => [
              styles.closeBtn,
              {
                opacity: cancelling || isAtZero ? 0.4 : pressed ? 0.5 : 1,
              },
            ]}
          >
            {cancelling ? (
              <ActivityIndicator
                size="small"
                color={colors.mutedForeground}
              />
            ) : (
              <Feather name="x" size={16} color={colors.mutedForeground} />
            )}
          </Pressable>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // Outer wrapper handles safe-area + absolute positioning at app
  // root. pointerEvents="box-none" lets the rest of the screen stay
  // interactive — only the inner Pressable should consume touches.
  outer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
  },
  // Inner pill — mirrors ClockReceiptBanner's wrap for visual
  // consistency. Same horizontal margins, same radius, same
  // shadow tier.
  wrap: {
    marginHorizontal: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  iconWrap: {
    width: 22,
    alignItems: "center",
  },
  body: {
    flex: 1,
  },
  bodyTxt: {
    fontSize: 13,
    lineHeight: 18,
  },
  closeBtn: {
    padding: 4,
  },
});
