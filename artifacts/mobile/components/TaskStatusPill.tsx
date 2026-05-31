import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { TaskStatus } from "@/services/types";

/**
 * Visual + label metadata for the 3-state task status enum. Labels match
 * the web app's user-facing strings; colors are status-semantic (neutral
 * / amber / green) rather than theme tokens so a "Done" pill always reads
 * as done regardless of light/dark mode.
 */
export const TASK_STATUS_META: Record<
  TaskStatus,
  { label: string; color: string; bg: string }
> = {
  todo: { label: "To Do", color: "#64748B", bg: "rgba(100,116,139,0.16)" },
  in_progress: {
    label: "In Progress",
    color: "#D97706",
    bg: "rgba(217,119,6,0.16)",
  },
  done: { label: "Done", color: "#059669", bg: "rgba(5,150,105,0.16)" },
};

/**
 * Tappable status pill. When `onPress` is provided, tapping advances the
 * task one step in the todo → in_progress → done → todo cycle (handled by
 * the caller via DataContext.cycleTaskStatus). Read-only when omitted.
 */
export function TaskStatusPill({
  status,
  onPress,
}: {
  status: TaskStatus;
  onPress?: () => void;
}) {
  const meta = TASK_STATUS_META[status];
  const inner = (
    <View style={[styles.pill, { backgroundColor: meta.bg }]}>
      <View style={[styles.dot, { backgroundColor: meta.color }]} />
      <Text style={[styles.label, { color: meta.color }]}>{meta.label}</Text>
    </View>
  );

  if (!onPress) return inner;
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      accessibilityRole="button"
      accessibilityLabel={`Status: ${meta.label}. Tap to advance.`}
    >
      {inner}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    alignSelf: "flex-start",
  },
  dot: { width: 7, height: 7, borderRadius: 999 },
  label: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
});
