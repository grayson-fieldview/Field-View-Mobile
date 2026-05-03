import { Feather } from "@expo/vector-icons";
import React, {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";
import {
  useLocationPermission,
  type LocationPermissionStatus,
} from "@/services/permissions";

/**
 * Re-engagement banner for location permission shortfalls. Mounted once
 * inside (tabs)/_layout above the tab content (NOT an overlay — overlays
 * eat scroll taps and read as ad-like).
 *
 * Visibility:
 *   - Hidden when status is "always-granted" (nothing to nudge) or
 *     "loading" (pre-resolution flicker).
 *   - Hidden when the user has dismissed it this session. Dismissal lives
 *     in `LocationBannerProvider`'s in-memory state — re-appears on cold
 *     start by design.
 *
 * The dismissal state must be lifted to a provider so the (tabs) layout
 * can conditionally override SafeAreaInsetsContext for the tab subtree;
 * tab screens already pad with `insets.top + 12` internally, so the
 * banner needs to claim the safe-area-top while the screens see top=0
 * to avoid double-padding.
 */

interface DismissCtxValue {
  dismissed: boolean;
  dismiss: () => void;
}

const DismissCtx = createContext<DismissCtxValue>({
  dismissed: false,
  dismiss: () => {},
});

export function LocationBannerProvider({ children }: { children: ReactNode }) {
  const [dismissed, setDismissed] = useState(false);
  const value = useMemo<DismissCtxValue>(
    () => ({ dismissed, dismiss: () => setDismissed(true) }),
    [dismissed],
  );
  return <DismissCtx.Provider value={value}>{children}</DismissCtx.Provider>;
}

/**
 * Whether the banner currently wants to render. Exposed as a hook so the
 * layout can mirror the same gate when deciding whether to override
 * SafeAreaInsetsContext, without re-implementing the predicate.
 */
export function useLocationBannerActive(): boolean {
  const { status } = useLocationPermission();
  const { dismissed } = useContext(DismissCtx);
  if (dismissed) return false;
  if (status === "loading" || status === "always-granted") return false;
  return true;
}

interface CopyForStatus {
  body: string;
  cta: { label: string; onPress: () => void } | null;
}

function copyFor(
  status: LocationPermissionStatus,
  openSettings: () => Promise<void>,
): CopyForStatus | null {
  switch (status) {
    case "denied":
      return {
        body: "Auto clock-in is disabled. Enable location access to turn it on.",
        cta: { label: "Open Settings", onPress: () => void openSettings() },
      };
    case "foreground-granted":
      return {
        body: "Auto clock-in needs background location access.",
        cta: { label: "Open Settings", onPress: () => void openSettings() },
      };
    case "restricted":
      return {
        body: "Location is unavailable on this device.",
        cta: null,
      };
    case "undetermined":
      // Should be unreachable in practice — the onboarding gate handles
      // the undetermined case before the user reaches (tabs). Safe
      // fallback: behave like denied.
      return {
        body: "Auto clock-in is disabled. Enable location access to turn it on.",
        cta: { label: "Open Settings", onPress: () => void openSettings() },
      };
    case "loading":
    case "always-granted":
      return null;
  }
}

export function LocationPermissionBanner() {
  const colors = useColors();
  const active = useLocationBannerActive();
  const { status, openSettings } = useLocationPermission();
  const { dismiss } = useContext(DismissCtx);

  if (!active) return null;
  const copy = copyFor(status, openSettings);
  if (!copy) return null;

  const isRestricted = status === "restricted";

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.muted,
          borderBottomColor: colors.border,
        },
      ]}
    >
      <Feather
        name={isRestricted ? "lock" : "alert-circle"}
        size={18}
        color={isRestricted ? colors.mutedForeground : colors.primary}
        style={styles.leadingIcon}
      />
      <View style={styles.body}>
        <Text style={[styles.bodyText, { color: colors.foreground }]}>
          {copy.body}
        </Text>
        {copy.cta ? (
          <Pressable onPress={copy.cta.onPress} hitSlop={8}>
            <Text style={[styles.ctaText, { color: colors.primary }]}>
              {copy.cta.label}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <Pressable
        onPress={dismiss}
        hitSlop={10}
        accessibilityLabel="Dismiss"
        style={styles.dismiss}
      >
        <Feather name="x" size={18} color={colors.mutedForeground} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  leadingIcon: {
    marginTop: 1,
  },
  body: {
    flex: 1,
    gap: 4,
  },
  bodyText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    lineHeight: 18,
  },
  ctaText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  dismiss: {
    marginLeft: 4,
    marginTop: 1,
  },
});
