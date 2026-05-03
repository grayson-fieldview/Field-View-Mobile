import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { useColors } from "@/hooks/useColors";
import {
  locationOnboardingFlags,
  useLocationPermission,
  type LocationPermissionStatus,
} from "@/services/permissions";

/**
 * Two-phase flow:
 *
 *   "main"           → value-prop + primary action driven by `status`
 *   "alwaysUpgrade"  → interstitial after foreground grant. Re-grounds the
 *                      value prop right before iOS's one-shot Always
 *                      dialog so the user doesn't reflexively dismiss the
 *                      stacked second prompt.
 *
 * Skipping at any point sets `preprompted=true` so AuthGate never gates
 * the user here again; in-app banners handle re-engagement.
 */
type Phase = "main" | "alwaysUpgrade";

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
  const [phase, setPhase] = useState<Phase>("main");
  const [upgradeShown, setUpgradeShown] = useState<boolean | null>(null);

  // Read the persisted "Always upgrade already shown once" flag once on
  // mount so we don't burn iOS's single-shot Always dialog on a user who
  // has already declined it.
  useEffect(() => {
    let alive = true;
    locationOnboardingFlags.getUpgradeShown().then((v) => {
      if (alive) setUpgradeShown(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  // All exit paths funnel through here so AuthGate's `preprompted` skip
  // condition is set exactly once. Idempotent — safe to call repeatedly.
  const exitToApp = useCallback(async () => {
    await locationOnboardingFlags.setPreprompted();
    router.replace("/(tabs)");
  }, [router]);

  // Auto-advance once the user reaches Always — there's nothing left to
  // ask for and no decision to surface.
  useEffect(() => {
    if (status === "always-granted") {
      void exitToApp();
    }
  }, [status, exitToApp]);

  const handleEnable = useCallback(async () => {
    setBusy(true);
    try {
      const next = await requestForegroundPermission();
      if (next === "foreground-granted" && upgradeShown === false) {
        // Don't auto-chain into the system dialog. Surface the
        // interstitial first so the user re-grounds before the one-shot
        // Always prompt.
        setPhase("alwaysUpgrade");
      } else {
        // Granted Always somehow, denied, or restricted — nothing more
        // to ask. The status-driven render handles the rest.
      }
    } finally {
      setBusy(false);
    }
  }, [requestForegroundPermission, upgradeShown]);

  const handleAlwaysContinue = useCallback(async () => {
    setBusy(true);
    try {
      // Persist BEFORE the request so a crash mid-prompt doesn't burn
      // the dialog twice on next launch.
      await locationOnboardingFlags.setUpgradeShown();
      setUpgradeShown(true);
      await requestBackgroundPermission();
    } finally {
      setBusy(false);
      // Whether the user granted, denied, or dismissed Always, the
      // onboarding is done. The banner re-engages later if needed.
      void exitToApp();
    }
  }, [requestBackgroundPermission, exitToApp]);

  const showSkip =
    status !== "loading" &&
    status !== "always-granted" &&
    status !== "restricted";

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
        {phase === "main" ? (
          <MainCopy status={status} onOpenSettings={openSettings} />
        ) : (
          <AlwaysUpgradeCopy />
        )}
      </View>

      <View style={styles.footer}>
        <PrimaryAction
          phase={phase}
          status={status}
          busy={busy}
          upgradeShown={upgradeShown}
          onEnable={handleEnable}
          onAlwaysContinue={handleAlwaysContinue}
          onContinue={exitToApp}
          onOpenSettings={openSettings}
        />
        {showSkip ? (
          <Pressable
            onPress={exitToApp}
            hitSlop={10}
            style={{ alignSelf: "center", marginTop: 14 }}
          >
            <Text style={[styles.skip, { color: colors.mutedForeground }]}>
              Not now
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

// --- Copy blocks -----------------------------------------------------------

function MainCopy({
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

// --- Primary CTA -----------------------------------------------------------

function PrimaryAction({
  phase,
  status,
  busy,
  upgradeShown,
  onEnable,
  onAlwaysContinue,
  onContinue,
  onOpenSettings,
}: {
  phase: Phase;
  status: LocationPermissionStatus;
  busy: boolean;
  upgradeShown: boolean | null;
  onEnable: () => void;
  onAlwaysContinue: () => void;
  onContinue: () => void;
  onOpenSettings: () => void;
}) {
  if (status === "loading" || upgradeShown === null) {
    return <Button title="Enable Location" onPress={() => {}} loading />;
  }

  if (phase === "alwaysUpgrade") {
    return (
      <Button
        title="Continue"
        size="lg"
        loading={busy}
        onPress={onAlwaysContinue}
      />
    );
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

  if (status === "foreground-granted") {
    return <Button title="Continue" size="lg" onPress={onContinue} />;
  }

  if (status === "always-granted") {
    return <Button title="Continue" size="lg" onPress={onContinue} />;
  }

  if (status === "denied") {
    return (
      <Button title="Open Settings" size="lg" onPress={onOpenSettings} />
    );
  }

  // restricted — promote to primary since it's the only available action.
  return (
    <Button
      title="Continue without location"
      variant="primary"
      size="lg"
      onPress={onContinue}
    />
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
  skip: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
});
