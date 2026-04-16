import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { useAuth } from "@/contexts/AuthContext";
import { useData } from "@/contexts/DataContext";
import { useColors } from "@/hooks/useColors";

export default function ProfileScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, signOut } = useAuth();
  const { projects, photos, tasks } = useData();

  const onSignOut = () => {
    if (Platform.OS === "web") {
      signOut();
      return;
    }
    Alert.alert("Sign out?", "You’ll need to sign in again to access your projects.", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: signOut },
    ]);
  };

  return (
    <View
      style={[
        styles.wrap,
        {
          backgroundColor: colors.background,
          paddingTop: insets.top + (Platform.OS === "web" ? 67 : 12),
          paddingBottom: insets.bottom + 100,
        },
      ]}
    >
      <View style={styles.headerBlock}>
        <View
          style={[styles.avatar, { backgroundColor: colors.primary }]}
        >
          <Text style={[styles.avatarText, { color: colors.primaryForeground }]}>
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
        <Row icon="cloud" label="Sync backend" value={
          process.env.EXPO_PUBLIC_API_URL ? "Connected" : "Offline (local)"
        } />
        <Row icon="shield" label="Privacy" value="Photos stored on device" />
        <Row icon="info" label="Version" value="1.0.0" />
      </View>

      <View style={{ paddingHorizontal: 20, marginTop: 24 }}>
        <Button title="Sign out" variant="secondary" onPress={onSignOut} />
      </View>
    </View>
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
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value: string;
}) {
  const colors = useColors();
  return (
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      <View style={styles.rowLeft}>
        <Feather name={icon} size={18} color={colors.mutedForeground} />
        <Text style={[styles.rowLabel, { color: colors.foreground }]}>
          {label}
        </Text>
      </View>
      <Text style={[styles.rowValue, { color: colors.mutedForeground }]}>
        {value}
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
});
