import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
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

import { EmptyState } from "@/components/EmptyState";
import { LoadingScreen } from "@/components/LoadingScreen";
import { useData } from "@/contexts/DataContext";
import { useColors } from "@/hooks/useColors";

export default function TasksScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { tasks, projects, toggleTask, ready } = useData();

  const projectNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.name);
    return m;
  }, [projects]);

  const sorted = useMemo(
    () =>
      [...tasks].sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        return b.createdAt.localeCompare(a.createdAt);
      }),
    [tasks],
  );

  if (!ready) return <LoadingScreen />;

  const openCount = tasks.filter((t) => !t.done).length;

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
        <Text style={[styles.eyebrow, { color: colors.mutedForeground }]}>
          {openCount} OPEN
        </Text>
        <Text style={[styles.title, { color: colors.foreground }]}>Tasks</Text>
      </View>

      <FlatList
        data={sorted}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{
          padding: 20,
          paddingBottom: insets.bottom + 100,
          gap: 8,
          flexGrow: 1,
        }}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => {
              Haptics.selectionAsync().catch(() => {});
              toggleTask(item.id);
            }}
            onLongPress={() => router.push(`/project/${item.projectId}`)}
            style={({ pressed }) => [
              styles.row,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                opacity: pressed ? 0.95 : 1,
              },
            ]}
          >
            <View
              style={[
                styles.checkbox,
                {
                  borderColor: item.done ? colors.primary : colors.border,
                  backgroundColor: item.done ? colors.primary : "transparent",
                },
              ]}
            >
              {item.done ? (
                <Feather
                  name="check"
                  size={14}
                  color={colors.primaryForeground}
                />
              ) : null}
            </View>
            <View style={{ flex: 1 }}>
              <Text
                style={[
                  styles.taskTitle,
                  {
                    color: item.done ? colors.mutedForeground : colors.foreground,
                    textDecorationLine: item.done ? "line-through" : "none",
                  },
                ]}
                numberOfLines={2}
              >
                {item.title}
              </Text>
              <Text
                style={[styles.taskMeta, { color: colors.mutedForeground }]}
                numberOfLines={1}
              >
                {projectNameById.get(item.projectId) ?? "Project"}
              </Text>
            </View>
            <Feather
              name="chevron-right"
              size={18}
              color={colors.mutedForeground}
            />
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={{ flex: 1, justifyContent: "center", paddingTop: 60 }}>
            <EmptyState
              icon="check-square"
              title="No tasks yet"
              description="Open a project and add your first task to keep the crew aligned."
            />
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  header: {
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
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  taskTitle: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
  },
  taskMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
});
