import { Feather } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import React, { useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
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
import { ApiError, api } from "@/services/api";

export default function ProfileScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, signOut } = useAuth();
  const { projects, photos, tasks, clearAll } = useData();
  const { showToast } = useToast();

  const isOwner = user?.isOwner ?? false;
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

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
      "This permanently deletes the entire account, all projects, all photos, all team members, and your subscription. After 30 days, all data is destroyed and cannot be recovered.",
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
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value?: string;
  onPress?: () => void;
}) {
  const colors = useColors();
  const body = (
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      <View style={styles.rowLeft}>
        <Feather name={icon} size={18} color={colors.mutedForeground} />
        <Text style={[styles.rowLabel, { color: colors.foreground }]}>
          {label}
        </Text>
      </View>
      {onPress ? (
        <Feather
          name="chevron-right"
          size={18}
          color={colors.mutedForeground}
        />
      ) : (
        <Text style={[styles.rowValue, { color: colors.mutedForeground }]}>
          {value}
        </Text>
      )}
    </View>
  );
  if (onPress) {
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
});
