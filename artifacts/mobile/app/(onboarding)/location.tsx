import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { useColors } from "@/hooks/useColors";
import {
  notificationOnboardingFlags,
  requestNotificationPermission,
} from "@/services/notifications";
import {
  beginPermissionRequest,
  endPermissionRequest,
  locationOnboardingFlags,
  useLocationPermission,
  type LocationPermissionStatus,
} from "@/services/permissions";

/**
 * Three-phase imperative onboarding controller (Build 23).
 *
 *   "foreground"     → value-prop + "Enable Location" → await
 *                      requestForegroundPermissionsAsync → advance
 *                      to alwaysUpgrade regardless of grant/deny.
 *   "alwaysUpgrade"  → "One more step" interstitial → "Continue" →
 *                      burn @fv/onboarding/locationUpgradeShown
 *                      BEFORE the call → await
 *                      requestBackgroundPermissionsAsync → advance
 *                      to notifications regardless of outcome.
 *   "notifications"  → "Stay informed" pre-prompt → "Turn on
 *                      notifications" OR "Not now" → notifications
 *                      branch awaits Notifications.requestPermissions
 *                      (the single owner of that request across
 *                      the entire app) → stamp
 *                      @fv/onboarding/notificationsPrompted in a
 *                      finally → exitToApp.
 *
 * Design invariants:
 *   1. Phase is owned by component state, set EXPLICITLY by step
 *      handlers (and once at mount based on incoming status).
 *      Status churn from AppState→active transitions (worse on
 *      iPad while iOS dialogs show/hide) MUST NOT mutate phase.
 *   2. Each request*PermissionsAsync await is bracketed by
 *      beginPermissionRequest() / endPermissionRequest() so the
 *      useLocationPermission AppState listener suppresses
 *      `status` refresh while the dialog is up. Combined with #1
 *      this guarantees the iPad loop cannot recur — neither the
 *      phase machine nor AuthGate's needsOnboarding can re-derive
 *      mid-flow.
 *   3. Every exit path (foreground "Continue without location",
 *      notifications enable/skip) routes through `exitToApp`,
 *      which burns BOTH @fv/onboarding/preprompted AND
 *      @fv/onboarding/locationUpgradeShown. Closes the
 *      asymmetric-flag risk at the write source.
 */
type Phase = "loading" | "foreground" | "alwaysUpgrade" | "notifications";

export default function LocationOnboardingScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    status,
    requestForegroundPermission,
    requestBackgroundPermission,
    openSettings,
  } = useLocationPermission();

  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("loading");
  const [upgradeShown, setUpgradeShown] = useState<boolean | null>(null);

  // Read the persisted "Always upgrade already shown once" flag on
  // mount so we don't burn iOS's single-shot Always dialog on a user
  // who has already declined it. Mount-only — never re-read.
  useEffect(() => {
    let alive = true;
    locationOnboardingFlags.getUpgradeShown().then((v) => {
      if (alive) setUpgradeShown(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Single point of exit. Burns BOTH onboarding flags so:
  //   - preprompted=true → AuthGate skips onboarding on next launch
  //   - upgradeShown=true → if a future bug ever bounces this screen
  //     back up, we don't re-burn iOS's one-shot Always dialog
  // Idempotent on both flags (storage.setFlag(...,true) is a no-op
  // when already true). Build 23: closes the asymmetric-flag TODO.
  const exitToApp = useCallback(async () => {
    try {
      await locationOnboardingFlags.setPreprompted();
    } catch {
      /* best-effort — storage failure must not block exit */
    }
    try {
      await locationOnboardingFlags.setUpgradeShown();
    } catch {
      /* best-effort */
    }
    router.replace("/(tabs)");
  }, [router]);

  // Mount-once phase selection. Runs exactly one time per screen
  // mount, gated by phaseInitRef. Status changes AFTER this fires
  // do NOT re-derive phase — that's the whole point of the iPad
  // fix. Subsequent phase transitions are owned by step handlers.
  const phaseInitRef = useRef(false);
  useEffect(() => {
    if (phaseInitRef.current) return;
    if (status === "loading" || upgradeShown === null) return;
    phaseInitRef.current = true;
    if (status === "always-granted") {
      // Returning user with full location grant but preprompted=false
      // (otherwise AuthGate wouldn't have routed them here). Skip
      // both location phases; still surface the notifications step.
      setPhase("notifications");
    } else if (status === "foreground-granted") {
      setPhase(upgradeShown ? "notifications" : "alwaysUpgrade");
    } else if (status === "restricted") {
      // Nothing actionable for location; still ask about notifications.
      setPhase("notifications");
    } else {
      // undetermined OR denied — show foreground step. Denied users
      // can tap "Open Settings"; the phase will not change on return.
      setPhase("foreground");
    }
  }, [status, upgradeShown]);

  // --- Step handlers ------------------------------------------------------

  const handleEnableForeground = useCallback(async () => {
    setBusy(true);
    beginPermissionRequest();
    try {
      await requestForegroundPermission();
    } finally {
      endPermissionRequest();
      setBusy(false);
      // Advance regardless of grant/deny per the strict-serial spec.
      // If denied, the subsequent alwaysUpgrade request will be a
      // no-op at the OS level (no dialog), and we'll fall through
      // to the notifications step.
      setPhase("alwaysUpgrade");
    }
  }, [requestForegroundPermission]);

  // For the foreground phase when status arrives as fg-granted
  // (e.g. user previously tapped "Open Settings" on denied and
  // granted in iOS Settings, then returned). Advances explicitly;
  // does not call request*.
  const handleForegroundContinue = useCallback(() => {
    setPhase(upgradeShown ? "notifications" : "alwaysUpgrade");
  }, [upgradeShown]);

  // For the foreground phase under `restricted` — terminal, no
  // location available. Skip both location phases entirely.
  const handleForegroundContinueWithoutLocation = useCallback(() => {
    setPhase("notifications");
  }, []);

  const handleAlwaysContinue = useCallback(async () => {
    setBusy(true);
    // Persist BEFORE the request so a crash mid-prompt doesn't burn
    // iOS's one-shot dialog twice on next launch.
    try {
      await locationOnboardingFlags.setUpgradeShown();
      setUpgradeShown(true);
    } catch {
      /* best-effort */
    }
    beginPermissionRequest();
    try {
      await requestBackgroundPermission();
    } finally {
      endPermissionRequest();
      setBusy(false);
      setPhase("notifications");
    }
  }, [requestBackgroundPermission]);

  const handleNotificationsEnable = useCallback(async () => {
    setBusy(true);
    beginPermissionRequest();
    try {
      await requestNotificationPermission();
    } finally {
      endPermissionRequest();
      // Stamp regardless of outcome so the geofence-sync check-only
      // path short-circuits forever after.
      try {
        await notificationOnboardingFlags.setPrompted();
      } catch {
        /* best-effort */
      }
      setBusy(false);
    }
    void exitToApp();
  }, [exitToApp]);

  const handleNotificationsSkip = useCallback(async () => {
    setBusy(true);
    try {
      await notificationOnboardingFlags.setPrompted();
    } catch {
      /* best-effort */
    }
    setBusy(false);
    void exitToApp();
  }, [exitToApp]);

  // --- Render -------------------------------------------------------------

  return (
    <View
      style={[
        styles.page,
        {
          backgroundColor: colors.background,
          paddingTop: insets.top + 24,
          paddingBottom: insets.bottom + 24,
        },
      ]}
    >
      <View style={styles.content}>
        {phase === "foreground" && (
          <ForegroundCopy status={status} onOpenSettings={openSettings} />
        )}
        {phase === "alwaysUpgrade" && <AlwaysUpgradeCopy />}
        {phase === "notifications" && <NotificationsCopy />}
      </View>

      <View style={styles.footer}>
        {phase === "loading" && (
          <Button title="Enable Location" onPress={() => {}} loading />
        )}
        {phase === "foreground" && (
          <ForegroundAction
            status={status}
            busy={busy}
            onEnable={handleEnableForeground}
            onContinue={handleForegroundContinue}
            onContinueWithoutLocation={handleForegroundContinueWithoutLocation}
            onOpenSettings={openSettings}
          />
        )}
        {phase === "alwaysUpgrade" && (
          <Button
            title="Continue"
            size="lg"
            loading={busy}
            onPress={handleAlwaysContinue}
          />
        )}
        {phase === "notifications" && (
          <NotificationsActions
            busy={busy}
            onEnable={handleNotificationsEnable}
            onSkip={handleNotificationsSkip}
          />
        )}
      </View>
    </View>
  );
}

// --- Copy blocks -----------------------------------------------------------

function ForegroundCopy({
  status,
  onOpenSettings,
}: {
  status: LocationPermissionStatus;
  onOpenSettings: () => Promise<void>;
}) {
  const colors = useColors();
  return (
    <>
      <View
        style={[
          styles.iconWrap,
          { backgroundColor: colors.muted, borderColor: colors.border },
        ]}
      >
        <Feather name="map-pin" size={32} color={colors.primary} />
      </View>
      <Text style={[styles.title, { color: colors.foreground }]}>
        Use your location
      </Text>
      <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
        Field View tags photos and tasks with the job site so your team
        can find them on the map. We only read your location while
        you&apos;re using the app unless you opt in to background updates.
      </Text>
      <StatusBanner status={status} onOpenSettings={onOpenSettings} />
    </>
  );
}

function AlwaysUpgradeCopy() {
  const colors = useColors();
  return (
    <>
      <View
        style={[
          styles.iconWrap,
          { backgroundColor: colors.muted, borderColor: colors.border },
        ]}
      >
        <Feather name="clock" size={32} color={colors.primary} />
      </View>
      <Text style={[styles.title, { color: colors.foreground }]}>
        One more step
      </Text>
      <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
        To clock you in automatically when you&apos;re not actively using
        the app, iOS needs to ask one more time. Tap{" "}
        <Text style={{ fontFamily: "Inter_600SemiBold" }}>
          &ldquo;Change to Always Allow&rdquo;
        </Text>{" "}
        on the next prompt.
      </Text>
    </>
  );
}

function NotificationsCopy() {
  const colors = useColors();
  return (
    <>
      <View
        style={[
          styles.iconWrap,
          { backgroundColor: colors.muted, borderColor: colors.border },
        ]}
      >
        <Feather name="bell" size={32} color={colors.primary} />
      </View>
      <Text style={[styles.title, { color: colors.foreground }]}>
        Stay informed
      </Text>
      <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
        We&apos;ll let you know when you&apos;re clocked in or out
        automatically, so you always have a clear record of your day —
        even when the app isn&apos;t open.
      </Text>
    </>
  );
}

function StatusBanner({
  status,
  onOpenSettings,
}: {
  status: LocationPermissionStatus;
  onOpenSettings: () => Promise<void>;
}) {
  const colors = useColors();

  if (status === "denied") {
    return (
      <View
        style={[
          styles.banner,
          { backgroundColor: colors.muted, borderColor: colors.border },
        ]}
      >
        <Feather name="alert-circle" size={18} color={colors.destructive} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.bannerTitle, { color: colors.foreground }]}>
            Location is off
          </Text>
          <Text
            style={[styles.bannerBody, { color: colors.mutedForeground }]}
          >
            Enable location for Field View in Settings to continue.
          </Text>
          <Pressable onPress={onOpenSettings} hitSlop={6}>
            <Text style={[styles.bannerLink, { color: colors.primary }]}>
              Open Settings
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (status === "restricted") {
    return (
      <View
        style={[
          styles.banner,
          { backgroundColor: colors.muted, borderColor: colors.border },
        ]}
      >
        <Feather name="lock" size={18} color={colors.mutedForeground} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.bannerTitle, { color: colors.foreground }]}>
            Location unavailable on this device
          </Text>
          <Text
            style={[styles.bannerBody, { color: colors.mutedForeground }]}
          >
            This may be controlled by parental controls or your
            organization&apos;s device policy. Contact your administrator
            if you need access.
          </Text>
        </View>
      </View>
    );
  }

  return null;
}

// --- Action blocks ---------------------------------------------------------

function ForegroundAction({
  status,
  busy,
  onEnable,
  onContinue,
  onContinueWithoutLocation,
  onOpenSettings,
}: {
  status: LocationPermissionStatus;
  busy: boolean;
  onEnable: () => void;
  onContinue: () => void;
  onContinueWithoutLocation: () => void;
  onOpenSettings: () => void;
}) {
  if (status === "loading") {
    return <Button title="Enable Location" onPress={() => {}} loading />;
  }

  if (status === "undetermined") {
    return (
      <Button
        title="Enable Location"
        size="lg"
        loading={busy}
        onPress={onEnable}
      />
    );
  }

  if (status === "foreground-granted" || status === "always-granted") {
    // User returned from Settings (or status was already advanced
    // out from under us). Advance explicitly without re-requesting.
    return <Button title="Continue" size="lg" onPress={onContinue} />;
  }

  if (status === "denied") {
    return (
      <Button title="Open Settings" size="lg" onPress={onOpenSettings} />
    );
  }

  // restricted — promote to primary since it's the only available
  // action. Routes through `Continue without location` → notifications
  // step → exitToApp.
  return (
    <Button
      title="Continue without location"
      variant="primary"
      size="lg"
      onPress={onContinueWithoutLocation}
    />
  );
}

function NotificationsActions({
  busy,
  onEnable,
  onSkip,
}: {
  busy: boolean;
  onEnable: () => void;
  onSkip: () => void;
}) {
  const colors = useColors();
  return (
    <>
      <Button
        title="Turn on notifications"
        size="lg"
        loading={busy}
        onPress={onEnable}
      />
      <Pressable
        onPress={onSkip}
        disabled={busy}
        hitSlop={10}
        style={styles.skipButton}
      >
        <Text style={[styles.skipText, { color: colors.mutedForeground }]}>
          Not now
        </Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: "space-between",
  },
  content: {
    alignItems: "center",
    marginTop: 32,
  },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
  },
  title: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.6,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    lineHeight: 22,
    textAlign: "center",
    marginTop: 10,
  },
  banner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 14,
    marginTop: 24,
    width: "100%",
  },
  bannerTitle: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  bannerBody: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
    marginTop: 2,
  },
  bannerLink: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    marginTop: 8,
  },
  footer: {
    width: "100%",
  },
  skipButton: {
    alignSelf: "center",
    paddingVertical: 14,
    marginTop: 4,
  },
  skipText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
  },
});
