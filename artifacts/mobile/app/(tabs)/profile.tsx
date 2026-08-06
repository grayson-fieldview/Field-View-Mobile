import { useRouter } from "expo-router";
import React from "react";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { useAuth } from "@/contexts/AuthContext";
import { useData } from "@/contexts/DataContext";
import { useColors } from "@/hooks/useColors";

/**
 * Profile tab — identity + stats only. Everything account-related
 * (preferences, legal, sign out, danger zone) lives on the Settings
 * screen; name/phone edits live on Edit Profile. Both are hidden
 * (href: null) sibling routes in this tab group.
 */
export default function ProfileScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const { projects, photos, tasks } = useData();

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

      <View style={styles.actions}>
        <Button
          title="Edit Profile"
          variant="secondary"
          onPress={() => router.push("/(tabs)/edit-profile")}
        />
        <Button
          title="Settings"
          variant="secondary"
          onPress={() => router.push("/(tabs)/settings")}
        />
      </View>
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
  actions: { paddingHorizontal: 20, marginTop: 24, gap: 12 },
});
