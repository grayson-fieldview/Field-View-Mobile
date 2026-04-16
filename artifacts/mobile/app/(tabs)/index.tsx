import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useMemo } from "react";
import {
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { LoadingScreen } from "@/components/LoadingScreen";
import { useData } from "@/contexts/DataContext";
import { useColors } from "@/hooks/useColors";
import type { Project } from "@/services/types";

export default function ProjectsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { projects, photos, tasks, ready } = useData();

  const stats = useMemo(() => {
    const byProject = new Map<string, { photos: number; openTasks: number }>();
    for (const p of projects)
      byProject.set(p.id, { photos: 0, openTasks: 0 });
    for (const ph of photos) {
      const s = byProject.get(ph.projectId);
      if (s) s.photos += 1;
    }
    for (const t of tasks) {
      if (t.done) continue;
      const s = byProject.get(t.projectId);
      if (s) s.openTasks += 1;
    }
    return byProject;
  }, [projects, photos, tasks]);

  if (!ready) return <LoadingScreen />;

  return (
    <View style={[styles.wrap, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + (Platform.OS === "web" ? 67 : 12),
            borderBottomColor: colors.border,
          },
        ]}
      >
        <View>
          <Text style={[styles.eyebrow, { color: colors.mutedForeground }]}>
            FIELD VIEW
          </Text>
          <Text style={[styles.title, { color: colors.foreground }]}>
            Projects
          </Text>
        </View>
        <Pressable
          accessibilityLabel="New project"
          onPress={() => router.push("/project/new")}
          style={({ pressed }) => [
            styles.plus,
            {
              backgroundColor: colors.primary,
              opacity: pressed ? 0.85 : 1,
            },
          ]}
        >
          <Feather
            name="plus"
            size={22}
            color={colors.primaryForeground}
          />
        </Pressable>
      </View>

      <FlatList
        data={projects}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{
          padding: 20,
          paddingBottom: insets.bottom + 100,
          gap: 12,
          flexGrow: 1,
        }}
        renderItem={({ item }) => (
          <ProjectCard
            project={item}
            photoCount={stats.get(item.id)?.photos ?? 0}
            openTaskCount={stats.get(item.id)?.openTasks ?? 0}
            onPress={() => router.push(`/project/${item.id}`)}
          />
        )}
        ListEmptyComponent={
          <View style={{ flex: 1, justifyContent: "center", paddingTop: 60 }}>
            <EmptyState
              icon="folder"
              title="No projects yet"
              description="Create your first project to start capturing photos, tasks, and checklists."
              action={
                <Button
                  title="Create project"
                  onPress={() => router.push("/project/new")}
                />
              }
            />
          </View>
        }
      />
    </View>
  );
}

function ProjectCard({
  project,
  photoCount,
  openTaskCount,
  onPress,
}: {
  project: Project;
  photoCount: number;
  openTaskCount: number;
  onPress: () => void;
}) {
  const colors = useColors();
  const statusColor =
    project.status === "active"
      ? colors.primary
      : project.status === "complete"
        ? colors.success
        : colors.mutedForeground;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          opacity: pressed ? 0.95 : 1,
          transform: [{ scale: pressed ? 0.99 : 1 }],
        },
      ]}
    >
      <View style={styles.cardTopRow}>
        <View style={styles.cardTitleWrap}>
          <Text
            style={[styles.cardTitle, { color: colors.foreground }]}
            numberOfLines={1}
          >
            {project.name}
          </Text>
          <Text
            style={[styles.cardMeta, { color: colors.mutedForeground }]}
            numberOfLines={1}
          >
            {project.client || "—"} · {project.address || "No address"}
          </Text>
        </View>
        <View
          style={[
            styles.statusDot,
            { backgroundColor: statusColor },
          ]}
        />
      </View>

      <View style={[styles.cardStats, { borderTopColor: colors.border }]}>
        <Stat
          icon="camera"
          label="Photos"
          value={photoCount}
          color={colors.foreground}
          muted={colors.mutedForeground}
        />
        <View style={[styles.divider, { backgroundColor: colors.border }]} />
        <Stat
          icon="check-square"
          label="Open tasks"
          value={openTaskCount}
          color={colors.foreground}
          muted={colors.mutedForeground}
        />
        <View style={[styles.divider, { backgroundColor: colors.border }]} />
        <Stat
          icon="activity"
          label="Status"
          value={project.status}
          color={colors.foreground}
          muted={colors.mutedForeground}
        />
      </View>
    </Pressable>
  );
}

function Stat({
  icon,
  label,
  value,
  color,
  muted,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value: string | number;
  color: string;
  muted: string;
}) {
  return (
    <View style={styles.stat}>
      <Feather name={icon} size={14} color={muted} />
      <Text style={[styles.statValue, { color }]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={[styles.statLabel, { color: muted }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  eyebrow: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 2,
    marginBottom: 2,
  },
  title: {
    fontSize: 32,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.8,
  },
  plus: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 16,
  },
  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  cardTitleWrap: { flex: 1, gap: 4 },
  cardTitle: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: -0.3,
  },
  cardMeta: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  cardStats: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
  },
  stat: { flex: 1, alignItems: "flex-start", gap: 2 },
  statValue: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    textTransform: "capitalize",
  },
  statLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  divider: { width: StyleSheet.hairlineWidth, height: 28, marginHorizontal: 8 },
});
