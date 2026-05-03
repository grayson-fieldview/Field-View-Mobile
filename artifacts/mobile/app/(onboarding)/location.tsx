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

  const finish = useCallback(() => {
    router.replace("/(tabs)");
  }, [router]);

  // Auto-advance once the user has reached a terminal "granted" state
  // AND we've either shown or skipped the Always upgrade.
  useEffect(() => {
    if (status === "always-granted") finish();
  }, [status, finish]);

  const handleEnable = useCallback(async () => {
    setBusy(true);
    try {
      await locationOnboardingFlags.setPreprompted();
      const next = await requestForegroundPermission();
      // If foreground succeeded and we haven't burned the Always dialog
      // yet, immediately offer the upgrade in the same flow.
      if (next === "foreground-granted" && upgradeShown === false) {
        await locationOnboardingFlags.setUpgradeShown();
        setUpgradeShown(true);
        await requestBackgroundPermission();
      }
    } finally {
      setBusy(false);
    }
  }, [
    requestForegroundPermission,
    requestBackgroundPermission,
    upgradeShown,
  ]);

  const handleUpgrade = useCallback(async () => {
    setBusy(true);
    try {
      await locationOnboardingFlags.setUpgradeShown();
      setUpgradeShown(true);
      await requestBackgroundPermission();
    } finally {
      setBusy(false);
    }
  }, [requestBackgroundPermission]);

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

        <StatusBanner
          status={status}
          onOpenSettings={openSettings}
        />
      </View>

      <View style={styles.footer}>
        <PrimaryAction
          status={status}
          busy={busy}
          upgradeShown={upgradeShown}
          onEnable={handleEnable}
          onUpgrade={handleUpgrade}
          onContinue={finish}
          onOpenSettings={openSettings}
        />
        {status !== "loading" && status !== "always-granted" ? (
          <Pressable
            onPress={finish}
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

// --- Subcomponents ---------------------------------------------------------

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

function PrimaryAction({
  status,
  busy,
  upgradeShown,
  onEnable,
  onUpgrade,
  onContinue,
  onOpenSettings,
}: {
  status: LocationPermissionStatus;
  busy: boolean;
  upgradeShown: boolean | null;
  onEnable: () => void;
  onUpgrade: () => void;
  onContinue: () => void;
  onOpenSettings: () => void;
}) {
  if (status === "loading" || upgradeShown === null) {
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

  if (status === "foreground-granted") {
    // Only offer the explicit upgrade button if iOS hasn't burned the
    // Always dialog yet. Otherwise just let the user continue.
    if (!upgradeShown) {
      return (
        <Button
          title="Allow Always"
          size="lg"
          loading={busy}
          onPress={onUpgrade}
        />
      );
    }
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

  // restricted — no actionable primary CTA, just let them move on.
  return (
    <Button
      title="Continue without location"
      variant="secondary"
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
