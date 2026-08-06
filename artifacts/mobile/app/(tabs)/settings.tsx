import * as Application from "expo-application";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  Alert,
  AppState,
  Linking as RNLinking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { DeleteAccountConfirmModal } from "@/components/DeleteAccountConfirmModal";
import { Row } from "@/components/Row";
import { useAuth } from "@/contexts/AuthContext";
import { useData } from "@/contexts/DataContext";
import { useToast } from "@/contexts/ToastContext";
import { useColors } from "@/hooks/useColors";
import { ApiError, api } from "@/services/api";
import {
  DEFAULT_PHOTO_ASPECT_RATIO,
  PHOTO_ASPECT_RATIOS,
  type PhotoAspectRatio,
} from "@/services/imageProcessing";
import {
  getNotificationPermission,
  type NotificationPermissionStatus,
} from "@/services/notifications";

const SUPPORT_EMAIL = "support@field-view.com";
const APP_STORE_REVIEW_URL =
  "https://apps.apple.com/app/id6766534406?action=write-review";

/**
 * Settings screen — CompanyCam-style sectioned list. Hidden (href: null)
 * route in the (tabs) group; the Profile tab pushes to it. Everything
 * here moved from the old monolithic profile screen except name/phone
 * editing (Edit Profile) and identity/stats (Profile).
 */
export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    user,
    signOut,
    accountSettings,
    updateAccountSettings,
  } = useAuth();
  const { clearAll } = useData();
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
  // they'd come back and still see a stale subtitle until next
  // process restart.
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

  // openSettings() lives on react-native's Linking, NOT
  // expo-linking — the latter doesn't expose it. Aliased import
  // (RNLinking) keeps both available in this file.
  const openNotificationSettings = () => {
    void RNLinking.openSettings().catch((err) => {
      console.log("[settings] openSettings failed:", err);
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

  const openExternal = async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch {
      showToast("Couldn't open the link. Try again.");
    }
  };

  // Version/build from the native binary (expo-application). On web
  // (and in any environment where the native modules return null) we
  // fall back to the manifest version so the row never shows blank.
  const appVersion =
    Application.nativeApplicationVersion ??
    Constants.expoConfig?.version ??
    "unknown";
  const buildNumber = Application.nativeBuildVersion;
  const versionString = buildNumber
    ? `Version ${appVersion} (build ${buildNumber})`
    : `Version ${appVersion}`;

  const copyVersion = async () => {
    try {
      await Clipboard.setStringAsync(versionString);
      showToast("Copied to clipboard.");
    } catch {
      showToast("Couldn't copy.");
    }
  };

  const openBugReport = () => {
    const subject = encodeURIComponent("Field View bug report");
    const body = encodeURIComponent(
      [
        "",
        "",
        "—— Please keep the details below ——",
        `App version: ${appVersion} (build ${buildNumber ?? "n/a"})`,
        `OS: ${Device.osName ?? Platform.OS} ${Device.osVersion ?? ""}`.trim(),
        `Device: ${Device.modelName ?? "unknown"}`,
      ].join("\n"),
    );
    void openExternal(
      `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`,
    );
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
      {/* Header: back chevron + title. Tabs have headerShown: false, so
          this screen renders its own lightweight header. */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backBtn}
        >
          <Feather name="chevron-left" size={28} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>
          Settings
        </Text>
        {/* Spacer mirrors the back button so the title stays centered. */}
        <View style={styles.backBtn} />
      </View>

      {/* ——— Preferences ——— */}
      <View style={styles.section}>
        <Text style={[styles.sectionHeader, { color: colors.mutedForeground }]}>
          Preferences
        </Text>
        {isAdmin ? (
          <View style={styles.subBlock}>
            <Text
              style={[styles.blockLabel, { color: colors.foreground }]}
            >
              Photo Capture
            </Text>
            <Text
              style={[styles.blockCaption, { color: colors.mutedForeground }]}
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
        <Row
          icon="bell"
          label="Notifications"
          subtitle={
            notifPermission === "granted" ? "Enabled" : "Tap to enable"
          }
          onPress={openNotificationSettings}
        />
      </View>

      {/* ——— Help ——— */}
      <View style={styles.section}>
        <Text style={[styles.sectionHeader, { color: colors.mutedForeground }]}>
          Help
        </Text>
        <Row
          icon="mail"
          label="Contact Support"
          onPress={() => void openExternal(`mailto:${SUPPORT_EMAIL}`)}
        />
        <Row icon="alert-circle" label="Report a Bug" onPress={openBugReport} />
        {Platform.OS === "ios" ? (
          <Row
            icon="star"
            label="Rate Field View"
            onPress={() => void openExternal(APP_STORE_REVIEW_URL)}
          />
        ) : null}
        {isOwner ? (
          <Row
            icon="trash-2"
            label="Delete Account"
            destructive
            onPress={signingOut ? undefined : handleDeleteAccountStart}
          />
        ) : (
          <Row
            icon="log-out"
            label="Leave Team"
            destructive
            onPress={signingOut ? undefined : handleLeaveTeam}
          />
        )}
      </View>

      {/*
        Future "About" section goes here (above Legal), with a Billing row
        (plan / seats / trial status). The mobile billing endpoint is being
        built in parallel — placeholder only, no row yet.
      */}

      {/* ——— Legal ——— */}
      <View style={styles.section}>
        <Text style={[styles.sectionHeader, { color: colors.mutedForeground }]}>
          Legal
        </Text>
        <Row
          icon="shield"
          label="Privacy Policy"
          onPress={() =>
            void openExternal(
              "https://www.field-view.com/legal/privacy-policy",
            )
          }
        />
        <Row
          icon="file-text"
          label="Terms of Service"
          onPress={() =>
            void openExternal(
              "https://www.field-view.com/legal/terms-and-conditions",
            )
          }
        />
      </View>

      {/* ——— Bottom ——— */}
      <View style={styles.bottom}>
        <Button title="Sign out" variant="danger" onPress={onSignOut} />
        <Pressable
          onPress={() => void copyVersion()}
          accessibilityRole="button"
          accessibilityLabel={`${versionString}. Tap to copy.`}
        >
          <Text style={[styles.version, { color: colors.mutedForeground }]}>
            {versionString}
          </Text>
        </Pressable>
      </View>

      <DeleteAccountConfirmModal
        visible={showDeleteModal}
        onCancel={() => setShowDeleteModal(false)}
        onConfirm={handleDeleteAccountConfirm}
      />
    </ScrollView>
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

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
  },
  backBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
  },
  section: { marginTop: 24, marginHorizontal: 20 },
  sectionHeader: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  subBlock: { marginTop: 8, marginBottom: 8 },
  blockLabel: { fontSize: 15, fontFamily: "Inter_500Medium" },
  blockCaption: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    lineHeight: 16,
    marginTop: 4,
  },
  bottom: { paddingHorizontal: 20, marginTop: 32, gap: 14 },
  version: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
});
