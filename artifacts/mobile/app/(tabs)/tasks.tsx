import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  AssigneePickerSheet,
  type AssigneeSelection,
} from "@/components/AssigneePickerSheet";
import { EmptyState } from "@/components/EmptyState";
import { LoadingScreen } from "@/components/LoadingScreen";
import { TaskStatusPill } from "@/components/TaskStatusPill";
import { useData } from "@/contexts/DataContext";
import { useColors } from "@/hooks/useColors";
import { formatDueLabel, matchesDueFilter, type DueFilter } from "@/services/dueDate";
import type { Task, TaskStatus } from "@/services/types";

type StatusFilter = "all" | TaskStatus;

const STATUS_SEGMENTS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "todo", label: "To Do" },
  { key: "in_progress", label: "In Progress" },
  { key: "done", label: "Done" },
];

const DUE_SEGMENTS: { key: DueFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "today", label: "Due Today" },
  { key: "week", label: "This Week" },
  { key: "past", label: "Past Due" },
];

export default function TasksScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { tasks, projects, cycleTaskStatus, updateTask, ready } = useData();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [dueFilter, setDueFilter] = useState<DueFilter>("all");
  const [projectSheetOpen, setProjectSheetOpen] = useState(false);

  // Task currently having its assignee changed (drives the picker sheet).
  const [reassignTask, setReassignTask] = useState<Task | null>(null);

  const projectNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.name);
    return m;
  }, [projects]);

  const filtered = useMemo(() => {
    const now = new Date();
    const out = tasks.filter((t) => {
      if (statusFilter !== "all" && (t.status ?? "todo") !== statusFilter) {
        return false;
      }
      if (projectFilter !== "all" && t.projectId !== projectFilter) {
        return false;
      }
      if (!matchesDueFilter(t.dueDate, dueFilter, now)) return false;
      return true;
    });
    return out.sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [tasks, statusFilter, projectFilter, dueFilter]);

  const activeFilterCount =
    (statusFilter !== "all" ? 1 : 0) +
    (projectFilter !== "all" ? 1 : 0) +
    (dueFilter !== "all" ? 1 : 0);

  const clearFilters = () => {
    setStatusFilter("all");
    setProjectFilter("all");
    setDueFilter("all");
  };

  const onReassign = async (selection: AssigneeSelection) => {
    if (!reassignTask) return;
    const task = reassignTask;
    setReassignTask(null);
    try {
      await updateTask(task.id, {
        assignedToId: selection?.userId ?? null,
        assignedToName: selection?.displayName ?? null,
      });
    } catch {
      // updateTask reverts optimistic state on failure; nothing to do here.
    }
  };

  if (!ready) return <LoadingScreen />;

  const openCount = tasks.filter((t) => !t.done).length;
  const projectFilterLabel =
    projectFilter === "all"
      ? "All projects"
      : projectNameById.get(projectFilter) ?? "Project";

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
        data={filtered}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{
          padding: 20,
          paddingBottom: insets.bottom + 110,
          gap: 8,
          flexGrow: 1,
        }}
        ListHeaderComponent={
          <View style={{ gap: 12, marginBottom: 4 }}>
            {/* Status filter */}
            <Segmented
              segments={STATUS_SEGMENTS}
              value={statusFilter}
              onChange={setStatusFilter}
              colors={colors}
            />

            {/* Project + clear row */}
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Pressable
                onPress={() => setProjectSheetOpen(true)}
                style={({ pressed }) => [
                  styles.projectBtn,
                  {
                    backgroundColor: colors.card,
                    borderColor:
                      projectFilter !== "all" ? colors.primary : colors.border,
                    opacity: pressed ? 0.85 : 1,
                  },
                ]}
              >
                <Feather name="folder" size={14} color={colors.mutedForeground} />
                <Text
                  style={[styles.projectBtnText, { color: colors.foreground }]}
                  numberOfLines={1}
                >
                  {projectFilterLabel}
                </Text>
                <Feather
                  name="chevron-down"
                  size={16}
                  color={colors.mutedForeground}
                />
              </Pressable>
              {activeFilterCount > 0 ? (
                <Pressable
                  onPress={clearFilters}
                  style={({ pressed }) => [
                    styles.clearBtn,
                    { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
                  ]}
                >
                  <Feather name="x" size={14} color={colors.mutedForeground} />
                  <Text
                    style={[styles.clearText, { color: colors.mutedForeground }]}
                  >
                    Clear
                  </Text>
                </Pressable>
              ) : null}
            </View>

            {/* Due date filter */}
            <Segmented
              segments={DUE_SEGMENTS}
              value={dueFilter}
              onChange={setDueFilter}
              colors={colors}
            />
          </View>
        }
        renderItem={({ item }) => {
          const dueLabel = formatDueLabel(item.dueDate);
          const isPast = matchesDueFilter(item.dueDate, "past") && !item.done;
          return (
            <View
              style={[
                styles.row,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                },
              ]}
            >
              <View style={{ flex: 1, gap: 8 }}>
                <View style={styles.rowTop}>
                  <TaskStatusPill
                    status={item.status ?? "todo"}
                    onPress={() => {
                      Haptics.selectionAsync().catch(() => {});
                      cycleTaskStatus(item.id).catch(() => {});
                    }}
                  />
                  <Pressable
                    onPress={() => router.push(`/project/${item.projectId}`)}
                    hitSlop={10}
                    style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                    accessibilityRole="button"
                    accessibilityLabel="Open project"
                  >
                    <Feather
                      name="chevron-right"
                      size={18}
                      color={colors.mutedForeground}
                    />
                  </Pressable>
                </View>

                <Text
                  style={[
                    styles.taskTitle,
                    {
                      color: item.done
                        ? colors.mutedForeground
                        : colors.foreground,
                      textDecorationLine: item.done ? "line-through" : "none",
                    },
                  ]}
                  numberOfLines={2}
                >
                  {item.title}
                </Text>

                <View style={styles.metaRow}>
                  <View style={styles.metaItem}>
                    <Feather
                      name="folder"
                      size={12}
                      color={colors.mutedForeground}
                    />
                    <Text
                      style={[styles.metaText, { color: colors.mutedForeground }]}
                      numberOfLines={1}
                    >
                      {projectNameById.get(item.projectId) ?? "Project"}
                    </Text>
                  </View>

                  {dueLabel ? (
                    <View style={styles.metaItem}>
                      <Feather
                        name="calendar"
                        size={12}
                        color={isPast ? "#DC2626" : colors.mutedForeground}
                      />
                      <Text
                        style={[
                          styles.metaText,
                          {
                            color: isPast ? "#DC2626" : colors.mutedForeground,
                            fontFamily: isPast
                              ? "Inter_600SemiBold"
                              : "Inter_400Regular",
                          },
                        ]}
                      >
                        {dueLabel}
                      </Text>
                    </View>
                  ) : null}

                  {(item.requiredPhotoCount ?? 0) > 0 ? (
                    <View style={styles.metaItem}>
                      <Feather
                        name="camera"
                        size={12}
                        color={
                          !item.done &&
                          (item.attachedPhotoCount ?? 0) <
                            (item.requiredPhotoCount ?? 0)
                            ? "#D97706"
                            : colors.mutedForeground
                        }
                      />
                      <Text
                        style={[
                          styles.metaText,
                          {
                            color:
                              !item.done &&
                              (item.attachedPhotoCount ?? 0) <
                                (item.requiredPhotoCount ?? 0)
                                ? "#D97706"
                                : colors.mutedForeground,
                          },
                        ]}
                      >
                        {`${item.attachedPhotoCount ?? 0} of ${item.requiredPhotoCount} photos`}
                      </Text>
                    </View>
                  ) : null}
                </View>

                {/* Assignee chip — tap to reassign */}
                <Pressable
                  onPress={() => setReassignTask(item)}
                  hitSlop={6}
                  style={({ pressed }) => [
                    styles.assigneeChip,
                    {
                      borderColor: colors.border,
                      backgroundColor: colors.background,
                      opacity: pressed ? 0.7 : 1,
                    },
                  ]}
                >
                  <Feather
                    name={item.assignedToName ? "user" : "user-x"}
                    size={12}
                    color={colors.mutedForeground}
                  />
                  <Text
                    style={[
                      styles.assigneeText,
                      {
                        color: item.assignedToName
                          ? colors.foreground
                          : colors.mutedForeground,
                      },
                    ]}
                    numberOfLines={1}
                  >
                    {item.assignedToName ?? "Unassigned"}
                  </Text>
                </Pressable>
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={{ flex: 1, justifyContent: "center", paddingTop: 60 }}>
            {activeFilterCount > 0 ? (
              <EmptyState
                icon="filter"
                title="No matching tasks"
                description="No tasks match the current filters. Try clearing them."
              />
            ) : (
              <EmptyState
                icon="check-square"
                title="No tasks yet"
                description="Open a project and add your first task to keep the crew aligned."
              />
            )}
          </View>
        }
      />

      {/* Project filter sheet */}
      <ProjectFilterSheet
        visible={projectSheetOpen}
        projects={projects}
        selected={projectFilter}
        onClose={() => setProjectSheetOpen(false)}
        onSelect={(id) => {
          setProjectFilter(id);
          setProjectSheetOpen(false);
        }}
        colors={colors}
      />

      {/* Reassign picker — scoped to the task's project */}
      {reassignTask ? (
        <AssigneePickerSheet
          visible
          projectId={reassignTask.projectId}
          selectedUserId={reassignTask.assignedToId ?? null}
          onClose={() => setReassignTask(null)}
          onSelect={onReassign}
        />
      ) : null}
    </View>
  );
}

function Segmented<T extends string>({
  segments,
  value,
  onChange,
  colors,
}: {
  segments: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={[styles.segmented, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {segments.map((s) => {
        const active = s.key === value;
        return (
          <Pressable
            key={s.key}
            onPress={() => onChange(s.key)}
            style={[
              styles.segment,
              active && { backgroundColor: colors.primary },
            ]}
          >
            <Text
              style={[
                styles.segmentText,
                {
                  color: active ? colors.primaryForeground : colors.mutedForeground,
                },
              ]}
              numberOfLines={1}
            >
              {s.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ProjectFilterSheet({
  visible,
  projects,
  selected,
  onClose,
  onSelect,
  colors,
}: {
  visible: boolean;
  projects: { id: string; name: string }[];
  selected: string;
  onClose: () => void;
  onSelect: (id: string) => void;
  colors: ReturnType<typeof useColors>;
}) {
  const insets = useSafeAreaInsets();
  const rows: { id: string; name: string }[] = [
    { id: "all", name: "All projects" },
    ...projects,
  ];
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: colors.background,
            paddingBottom: insets.bottom + 16,
          },
        ]}
      >
        <View style={[styles.sheetHandle, { backgroundColor: colors.border }]} />
        <Text style={[styles.sheetTitle, { color: colors.foreground }]}>
          Filter by project
        </Text>
        <ScrollView style={{ maxHeight: 360 }}>
          {rows.map((p) => {
            const active = p.id === selected;
            return (
              <Pressable
                key={p.id}
                onPress={() => onSelect(p.id)}
                style={({ pressed }) => [
                  styles.sheetRow,
                  { opacity: pressed ? 0.7 : 1 },
                ]}
              >
                <Text
                  style={{
                    flex: 1,
                    color: colors.foreground,
                    fontFamily: active ? "Inter_600SemiBold" : "Inter_400Regular",
                    fontSize: 15,
                  }}
                  numberOfLines={1}
                >
                  {p.name}
                </Text>
                {active ? (
                  <Feather name="check" size={18} color={colors.primary} />
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </Modal>
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
  segmented: {
    flexDirection: "row",
    borderRadius: 12,
    borderWidth: 1,
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  projectBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  projectBtnText: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  clearBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
  },
  clearText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  row: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  taskTitle: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 14,
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  metaText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  assigneeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  assigneeText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    maxWidth: 200,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 999,
    alignSelf: "center",
    marginBottom: 14,
  },
  sheetTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    marginBottom: 8,
  },
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
  },
});
