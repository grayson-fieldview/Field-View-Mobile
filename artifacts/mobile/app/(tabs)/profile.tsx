import { Feather } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import React, { useEffect, useState } from "react";
import {
  Alert,
  AppState,
  Linking as RNLinking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { DeleteAccountConfirmModal } from "@/components/DeleteAccountConfirmModal";
import { useAuth } from "@/contexts/AuthContext";
import { useData } from "@/contexts/DataContext";
import { useToast } from "@/contexts/ToastContext";
import { useColors } from "@/hooks/useColors";
import { useGeofenceSync } from "@/hooks/useGeofenceSync";
import { ApiError, api } from "@/services/api";
import {
  DEFAULT_PHOTO_ASPECT_RATIO,
  PHOTO_ASPECT_RATIOS,
  type PhotoAspectRatio,
} from "@/services/imageProcessing";
import {
  getRegisteredGeofences,
  triggerSyntheticEnterForTesting,
  triggerSyntheticExitForTesting,
} from "@/services/geofencing";
import {
  getNotificationPermission,
  type NotificationPermissionStatus,
} from "@/services/notifications";
import { listPendingExits } from "@/services/pendingExits";
import { useLocationPermission } from "@/services/permissions";

export default function ProfileScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const {
    user,
    signOut,
    updatePreferences,
    accountSettings,
    updateAccountSettings,
  } = useAuth();
  const { projects, photos, tasks, clearAll } = useData();
  const { showToast } = useToast();

  const isOwner = user?.isOwner ?? false;
  // Admin gate for the account-level Photo Capture section. Same
  // pattern used elsewhere (app/project/[id].tsx:88). Matches the
  // server-side 403 on PATCH /api/account/settings — non-admins
  // never see the row, and even if they did the server would
  // reject the write.
  const isAdmin = user?.role === "admin";
  // Track which ratio is "in flight" so the segmented selector can
  // visually disable while the optimistic PATCH round-trips. Cleared
  // on both success and rollback.
  const [pendingAspectRatio, setPendingAspectRatio] =
    useState<PhotoAspectRatio | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  // Notification permission status, refreshed on mount AND on every
  // foreground transition. The user can flip the toggle in iOS
  // Settings while we're backgrounded — without the AppState hook,
  // they'd come back and still see the "enable notifications" row
  // until next process restart.
  const [notifPermission, setNotifPermission] =
    useState<NotificationPermissionStatus>("undetermined");
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const status = await getNotificationPermission();
      if (alive) setNotifPermission(status);
    };
    void refresh();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  const showNotifSettingsRow = notifPermission !== "granted";

  // openSettings() lives on react-native's Linking, NOT
  // expo-linking — the latter doesn't expose it. Aliased import
  // (RNLinking) keeps both available in this file.
  const openNotificationSettings = () => {
    void RNLinking.openSettings().catch((err) => {
      console.log("[profile] openSettings failed:", err);
      showToast("Couldn't open Settings.");
    });
  };

  const handleAspectRatioSelect = async (next: PhotoAspectRatio) => {
    // Already-current selections are no-ops — avoid a pointless
    // PATCH round-trip and an unnecessary "pending" flicker.
    if (
      (accountSettings?.defaultPhotoAspectRatio ??
        DEFAULT_PHOTO_ASPECT_RATIO) === next
    ) {
      return;
    }
    setPendingAspectRatio(next);
    try {
      await updateAccountSettings({ defaultPhotoAspectRatio: next });
    } catch (err) {
      // AuthContext rolled back local state. Surface the failure
      // here because AuthProvider mounts outside ToastProvider.
      const msg =
        err instanceof Error ? err.message : "Couldn't update setting.";
      showToast(msg);
    } finally {
      setPendingAspectRatio(null);
    }
  };

  const handleAutoTrackingToggle = async (next: boolean) => {
    // On toggle-OFF, warn about in-flight server-scheduled clock-outs.
    // The toggle governs *new* OS events; pending exits already
    // accepted by the server still fire as planned via cron.
    if (!next) {
      try {
        const pending = await listPendingExits();
        if (pending.length > 0) {
          showToast(
            "You have a pending auto clock-out. It'll still fire as planned.",
          );
        }
      } catch {
        /* best-effort warning — toggle still proceeds */
      }
    }
    try {
      await updatePreferences({ autoTrackingEnabled: next });
    } catch (err) {
      // AuthContext rolled back local state; surface the failure here
      // because AuthProvider is mounted outside ToastProvider.
      const msg =
        err instanceof Error ? err.message : "Couldn't update setting.";
      showToast(msg);
    }
  };

  const openExternal = async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch {
      showToast("Couldn't open the link. Try again.");
    }
  };

  const onSignOut = () => {
    if (Platform.OS === "web") {
      signOut();
      return;
    }
    Alert.alert(
      "Sign out?",
      "You’ll need to sign in again to access your projects.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Sign out", style: "destructive", onPress: signOut },
      ],
    );
  };

  const finishDeletion = async (toastMessage: string) => {
    setSigningOut(true);
    try {
      await clearAll();
    } finally {
      // Even if clearAll partially fails, we still sign out — the backend
      // already invalidated the session.
      await signOut();
      showToast(toastMessage);
    }
  };

  const handleLeaveTeam = () => {
    Alert.alert(
      "Leave team?",
      "You'll lose access to all projects, photos, and data on this team. You can rejoin within 30 days by signing back in. After 30 days, your account will be permanently deleted.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Leave team",
          style: "destructive",
          onPress: async () => {
            try {
              await api.deleteCurrentUser();
              await finishDeletion(
                "You've left the team. Sign back in within 30 days to restore your access.",
              );
            } catch (e) {
              const msg =
                e instanceof Error
                  ? e.message
                  : "Couldn't leave the team. Please try again.";
              showToast(msg);
            }
          },
        },
      ],
    );
  };

  const handleDeleteAccountStart = () => {
    Alert.alert(
      "Delete account?",
      "This permanently deletes the entire account, all projects, all photos, and all team members. After 30 days, all data is destroyed and cannot be recovered.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Continue",
          style: "destructive",
          onPress: () => setShowDeleteModal(true),
        },
      ],
    );
  };

  const handleDeleteAccountConfirm = async (password: string) => {
    try {
      await api.deleteAccount("DELETE", password);
    } catch (e) {
      // OAuth-only owners get 400 with a /forgot-password hint. Surface that
      // separately rather than as an inline password error, since the issue
      // isn't actually the password they typed.
      if (e instanceof ApiError && e.status === 400) {
        const bodyMsg =
          (e.body && typeof e.body === "object" && "message" in e.body
            ? String((e.body as { message?: string }).message ?? "")
            : "") || e.message;
        if (/forgot[- ]?password|set.*password|no password/i.test(bodyMsg)) {
          setShowDeleteModal(false);
          Alert.alert(
            "Set a password first",
            "You need to set a password before deleting the account. Visit field-view.com/forgot-password to set a password, then return here.",
            [{ text: "OK" }],
          );
          return;
        }
      }
      // Anything else (401 wrong password, 403 not owner, network) is
      // re-thrown so the modal can render it inline / bubble it up.
      throw e;
    }
    // Success — close modal, then clean up + sign out.
    setShowDeleteModal(false);
    await finishDeletion(
      "Account deleted. Sign in within 30 days to restore.",
    );
  };

  return (
    <ScrollView
      style={[styles.wrap, { backgroundColor: colors.background }]}
      contentContainerStyle={{
        paddingTop: insets.top + (Platform.OS === "web" ? 67 : 12),
        paddingBottom: insets.bottom + 100,
      }}
    >
      <View style={styles.headerBlock}>
        <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
          <Text
            style={[styles.avatarText, { color: colors.primaryForeground }]}
          >
            {(user?.name || "?").slice(0, 1).toUpperCase()}
          </Text>
        </View>
        <Text style={[styles.name, { color: colors.foreground }]}>
          {user?.name ?? "Signed out"}
        </Text>
        <Text style={[styles.email, { color: colors.mutedForeground }]}>
          {user?.email ?? ""}
        </Text>
      </View>

      <View style={styles.stats}>
        <StatBlock value={projects.length} label="Projects" />
        <StatBlock value={photos.length} label="Photos" />
        <StatBlock value={tasks.length} label="Tasks" />
      </View>

      <View style={styles.section}>
        <Row icon="info" label="Version" value="1.0.0" />
        <Row
          icon="shield"
          label="Privacy Policy"
          onPress={() => openExternal("https://field-view.com/privacy")}
        />
        <Row
          icon="file-text"
          label="Terms of Service"
          onPress={() => openExternal("https://field-view.com/terms")}
        />
      </View>

      {isAdmin ? (
        <View style={styles.section}>
          <Text style={[styles.debugHeader, { color: colors.mutedForeground }]}>
            Photo Capture
          </Text>
          <Text
            style={[styles.debugCaption, { color: colors.mutedForeground }]}
          >
            Existing photos keep their captured ratio. This setting only
            affects new captures.
          </Text>
          <AspectRatioSelector
            value={
              accountSettings?.defaultPhotoAspectRatio ??
              DEFAULT_PHOTO_ASPECT_RATIO
            }
            pending={pendingAspectRatio}
            onSelect={handleAspectRatioSelect}
          />
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={[styles.debugHeader, { color: colors.mutedForeground }]}>
          Tracking
        </Text>
        <Text style={[styles.debugCaption, { color: colors.mutedForeground }]}>
          Automatically clock in when you arrive at a job site and clock out
          when you leave. Turn off to manage clock-in/out manually.
        </Text>
        <Row
          icon="map-pin"
          label="Auto clock in/out"
          value={user?.autoTrackingEnabled ?? true}
          onValueChange={handleAutoTrackingToggle}
        />
      </View>

      {showNotifSettingsRow ? (
        <View style={styles.section}>
          <Text style={[styles.debugHeader, { color: colors.mutedForeground }]}>
            Notifications
          </Text>
          <Text
            style={[styles.debugCaption, { color: colors.mutedForeground }]}
          >
            {notifPermission === "denied"
              ? "Notifications are turned off, so you won't see receipts when the app auto-clocks you in. Open Settings to re-enable them."
              : "Get a quick receipt with an Undo option whenever the app auto-clocks you in at a job site."}
          </Text>
          <Row
            icon="bell"
            label="Open notification settings"
            onPress={openNotificationSettings}
          />
        </View>
      ) : null}

      <GeofenceDebugSection />

      <View style={{ paddingHorizontal: 20, marginTop: 24 }}>
        <Button title="Sign out" variant="secondary" onPress={onSignOut} />
      </View>

      {/* Danger Zone — sits at the absolute bottom of the scroll view. */}
      <View
        style={[
          styles.dangerZone,
          {
            borderColor: colors.destructive,
            backgroundColor: "rgba(220,38,38,0.06)",
          },
        ]}
      >
        <Text style={[styles.dangerHeader, { color: colors.destructive }]}>
          Danger Zone
        </Text>
        {isOwner ? (
          <>
            <Button
              title="Delete account"
              variant="danger"
              onPress={handleDeleteAccountStart}
              disabled={signingOut}
            />
            <Text
              style={[
                styles.dangerHelper,
                { color: colors.mutedForeground },
              ]}
            >
              This permanently deletes the entire account and all data after a
              30-day grace period. To leave the team without deleting the
              account, transfer ownership first.
            </Text>
          </>
        ) : (
          <Button
            title="Leave team"
            variant="danger"
            onPress={handleLeaveTeam}
            disabled={signingOut}
          />
        )}
      </View>

      <DeleteAccountConfirmModal
        visible={showDeleteModal}
        onCancel={() => setShowDeleteModal(false)}
        onConfirm={handleDeleteAccountConfirm}
      />
    </ScrollView>
  );
}

// Dev-only diagnostics for the iOS geofence lifecycle. Gated on
// __DEV__ so it's dead-code-eliminated in release builds — no manual
// cleanup needed before paid marketing launch. Reads from the shared
// GeofenceSyncProvider mounted in (tabs)/_layout.tsx, so tapping
// "Force Resync" drives the same state the rest of the app sees.
function GeofenceDebugSection() {
  if (!__DEV__) return null;
  return <GeofenceDebugSectionBody />;
}

function GeofenceDebugSectionBody() {
  const colors = useColors();
  const { status } = useLocationPermission();
  const { lastSync, registeredCount, syncing, forceResync } = useGeofenceSync();
  const [triggering, setTriggering] = useState<
    "none" | "full" | "force" | "exit"
  >("none");

  const lastSyncLabel = lastSync ? lastSync.toLocaleTimeString() : "Never";

  // Dev-only manual triggers. All pick the FIRST registered region.
  // Enter modes:
  //   - "full" runs the entire filter chain (incl. real GPS + proximity).
  //     Expects rejection when far from the chosen project — validates
  //     the filter is restrictive.
  //   - "force" bypasses proximity + GPS filters (debounce and
  //     activeTimesheet still run). Expects the banner to appear so
  //     the tester can validate banner → tap → API → DB persistence
  //     without physically standing at a job site.
  // Exit mode (S32a):
  //   - "exit" runs the full Exit filter chain (B5 → B2 → B3 → B4 → B1).
  //     Expects: if currently clocked in to the picked project, debounce
  //     POST fires and a pendingExit row appears in storage. Cron will
  //     then auto-clock-out after the server-side window expires;
  //     subsequent foreground refresh surfaces the kind="out" receipt
  //     banner. No bypass variant — the Exit filter chain is
  //     deliberately less restrictive than Enter (no proximity check,
  //     just GPS uncertainty + debounce + active-session gates), so
  //     the "full" path is testable under realistic field conditions
  //     without a force escape hatch. If the filter chain rejects in
  //     a way you didn't expect, that's the bug to investigate, not
  //     a hurdle to bypass.
  const triggerWith = async (mode: "full" | "force" | "exit") => {
    const registered = getRegisteredGeofences();
    const regionId = registered[0];
    if (!regionId) {
      console.log("[geofence] DEBUG: no registered regions; skipping trigger");
      return;
    }
    setTriggering(mode);
    try {
      if (mode === "exit") {
        await triggerSyntheticExitForTesting(regionId);
      } else {
        await triggerSyntheticEnterForTesting(regionId, {
          bypassFilters: mode === "force",
        });
      }
    } finally {
      setTriggering("none");
    }
  };

  return (
    <View style={styles.section}>
      <Text style={[styles.debugHeader, { color: colors.mutedForeground }]}>
        Geofence Debug
      </Text>
      <Text style={[styles.debugCaption, { color: colors.mutedForeground }]}>
        Visible only in development builds.
      </Text>
      <Row icon="map-pin" label="Permission" value={status} />
      <Row icon="clock" label="Last sync" value={lastSyncLabel} />
      <Row
        icon="layers"
        label="Registered regions"
        value={String(registeredCount)}
      />
      <View style={{ marginTop: 12 }}>
        <Button
          title={syncing ? "Syncing…" : "Force Resync"}
          variant="secondary"
          onPress={forceResync}
          disabled={syncing}
        />
      </View>
      {registeredCount > 0 ? (
        <>
          <View style={{ marginTop: 8 }}>
            <Button
              title={
                triggering === "full"
                  ? "Triggering…"
                  : "Trigger Test Enter (DEV)"
              }
              variant="secondary"
              onPress={() => triggerWith("full")}
              disabled={triggering !== "none"}
            />
          </View>
          <View style={{ marginTop: 8 }}>
            <Button
              title={
                triggering === "force"
                  ? "Triggering…"
                  : "Trigger Test Enter — Force (DEV)"
              }
              variant="secondary"
              onPress={() => triggerWith("force")}
              disabled={triggering !== "none"}
            />
          </View>
          <View style={{ marginTop: 8 }}>
            <Button
              title={
                triggering === "exit"
                  ? "Triggering…"
                  : "Trigger Test Exit (DEV)"
              }
              variant="secondary"
              onPress={() => triggerWith("exit")}
              disabled={triggering !== "none"}
            />
          </View>
        </>
      ) : null}
    </View>
  );
}

/**
 * Three-option segmented selector for the account-wide
 * defaultPhotoAspectRatio setting (S3y, admin-only). Pure UI — all
 * state lives in AuthContext via updateAccountSettings.
 *
 * `value` is the currently-applied ratio. `pending`, when non-null,
 * is the ratio the user just tapped that's mid-PATCH; we render it
 * as selected (optimistic) but disable the whole row so a fast
 * second tap can't queue overlapping writes. On rollback the parent
 * clears `pending` and `value` snaps back.
 */
function AspectRatioSelector({
  value,
  pending,
  onSelect,
}: {
  value: PhotoAspectRatio;
  pending: PhotoAspectRatio | null;
  onSelect: (next: PhotoAspectRatio) => void;
}) {
  const colors = useColors();
  const displayValue = pending ?? value;
  const disabled = pending !== null;

  // Display labels are PORTRAIT-shaped (B11) because field users
  // hold their phones portrait. Wire-format values stay landscape
  // ("4:3"/"1:1"/"16:9") for cross-platform parity with the web
  // app's enum — only the on-screen text differs.
  const labelFor = (r: PhotoAspectRatio): string => {
    switch (r) {
      case "4:3":
        return "3:4";
      case "1:1":
        return "1:1";
      case "16:9":
        return "9:16";
    }
  };
  const subLabelFor = (r: PhotoAspectRatio): string => {
    switch (r) {
      case "4:3":
        return "Standard";
      case "1:1":
        return "Square";
      case "16:9":
        return "Tall";
    }
  };

  return (
    <View style={[selectorStyles.row, { borderColor: colors.border }]}>
      {PHOTO_ASPECT_RATIOS.map((r, idx) => {
        const active = displayValue === r;
        const isFirst = idx === 0;
        const isLast = idx === PHOTO_ASPECT_RATIOS.length - 1;
        return (
          <Pressable
            key={r}
            onPress={() => onSelect(r)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={`${labelFor(r)} ${subLabelFor(r)}`}
            accessibilityState={{ selected: active, disabled }}
            style={[
              selectorStyles.cell,
              {
                backgroundColor: active ? colors.primary : colors.card,
                borderLeftWidth: isFirst ? 0 : StyleSheet.hairlineWidth,
                borderLeftColor: colors.border,
                opacity: disabled && !active ? 0.5 : 1,
                borderTopLeftRadius: isFirst ? 10 : 0,
                borderBottomLeftRadius: isFirst ? 10 : 0,
                borderTopRightRadius: isLast ? 10 : 0,
                borderBottomRightRadius: isLast ? 10 : 0,
              },
            ]}
          >
            <Text
              style={[
                selectorStyles.label,
                {
                  color: active
                    ? colors.primaryForeground
                    : colors.foreground,
                },
              ]}
            >
              {labelFor(r)}
            </Text>
            <Text
              style={[
                selectorStyles.sublabel,
                {
                  color: active
                    ? colors.primaryForeground
                    : colors.mutedForeground,
                },
              ]}
            >
              {subLabelFor(r)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const selectorStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    marginTop: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  cell: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems: "center",
    gap: 2,
  },
  label: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  sublabel: { fontSize: 11, fontFamily: "Inter_400Regular" },
});

function StatBlock({ value, label }: { value: number; label: string }) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.statBlock,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <Text style={[styles.statValue, { color: colors.foreground }]}>
        {value}
      </Text>
      <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>
        {label}
      </Text>
    </View>
  );
}

function Row({
  icon,
  label,
  value,
  onPress,
  onValueChange,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  /**
   * Right-side affordance precedence:
   *   onValueChange present  → render <Switch> (boolean value)
   *   onPress present        → render chevron-right (string value ignored)
   *   neither                → render value as plain text
   */
  value?: string | boolean;
  onPress?: () => void;
  onValueChange?: (next: boolean) => void;
}) {
  const colors = useColors();
  const isSwitch = onValueChange !== undefined;
  const body = (
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      <View style={styles.rowLeft}>
        <Feather name={icon} size={18} color={colors.mutedForeground} />
        <Text style={[styles.rowLabel, { color: colors.foreground }]}>
          {label}
        </Text>
      </View>
      {isSwitch ? (
        <Switch
          value={typeof value === "boolean" ? value : false}
          onValueChange={onValueChange}
          trackColor={{ true: colors.primary, false: colors.muted }}
          accessibilityLabel={label}
        />
      ) : onPress ? (
        <Feather
          name="chevron-right"
          size={18}
          color={colors.mutedForeground}
        />
      ) : (
        <Text style={[styles.rowValue, { color: colors.mutedForeground }]}>
          {typeof value === "string" ? value : ""}
        </Text>
      )}
    </View>
  );
  // Switch rows must NOT be wrapped in a Pressable — tapping the row
  // body would race the Switch's own gesture handler.
  if (onPress && !isSwitch) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="link"
        accessibilityLabel={label}
      >
        {body}
      </Pressable>
    );
  }
  return body;
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  headerBlock: { alignItems: "center", paddingVertical: 24, gap: 6 },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  avatarText: { fontSize: 28, fontFamily: "Inter_700Bold" },
  name: { fontSize: 22, fontFamily: "Inter_700Bold", letterSpacing: -0.4 },
  email: { fontSize: 14, fontFamily: "Inter_400Regular" },
  stats: { flexDirection: "row", paddingHorizontal: 20, gap: 10 },
  statBlock: {
    flex: 1,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: "flex-start",
    gap: 2,
  },
  statValue: { fontSize: 22, fontFamily: "Inter_700Bold" },
  statLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  section: { marginTop: 24, marginHorizontal: 20 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowLabel: { fontSize: 15, fontFamily: "Inter_500Medium" },
  rowValue: { fontSize: 14, fontFamily: "Inter_400Regular" },
  dangerZone: {
    marginTop: 32,
    marginHorizontal: 20,
    padding: 18,
    borderRadius: 16,
    borderWidth: 1,
    gap: 12,
  },
  dangerHeader: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  dangerHelper: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  debugHeader: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  debugCaption: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    lineHeight: 16,
    marginBottom: 4,
  },
});
