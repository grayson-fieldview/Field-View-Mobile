import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
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
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { PhotoPickerModal } from "@/components/PhotoPickerModal";
import { TaskStatusPill } from "@/components/TaskStatusPill";
import { useData } from "@/contexts/DataContext";
import { useToast } from "@/contexts/ToastContext";
import { useColors } from "@/hooks/useColors";
import { useTaskPhotos } from "@/hooks/useTaskPhotos";
import { formatDueLabel, matchesDueFilter } from "@/services/dueDate";

const TILE_GAP = 8;
const TILES_PER_ROW = 3;

/**
 * Task detail screen — the surface the list rows were standing in for.
 * Route: /task/[id]; pushed from a task row on the tasks tab and the
 * project screen. Task data comes from DataContext (already loaded for
 * the list to exist); attached-photo state comes from useTaskPhotos,
 * the same hook-lifted logic the old TaskPhotosSheet used.
 */
export default function TaskDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { showToast } = useToast();
  const {
    tasks,
    projects,
    photos,
    cycleTaskStatus,
    setTaskStatus,
    updateTask,
  } = useData();

  const task = useMemo(() => tasks.find((t) => t.id === id) ?? null, [tasks, id]);
  const project = useMemo(
    () => (task ? projects.find((p) => p.id === task.projectId) ?? null : null),
    [projects, task],
  );

  const {
    rows,
    loading,
    loadError,
    retryLoad,
    busy,
    attach,
    detach,
    takeNewPhoto,
    attachedMediaIds,
  } = useTaskPhotos(task);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [markingDone, setMarkingDone] = useState(false);

  const onReassign = async (selection: AssigneeSelection) => {
    if (!task) return;
    setReassignOpen(false);
    try {
      await updateTask(task.id, {
        assignedToId: selection?.userId ?? null,
        assignedToName: selection?.displayName ?? null,
      });
    } catch {
      // updateTask reverts optimistic state on failure; nothing to do here.
    }
  };

  // Tap-to-view: task photo rows are server media rows; the photo viewer
  // routes by LOCAL photo id, linked via Photo.mediaId (never Photo.id).
  const openPhoto = (mediaId: number) => {
    const photo = photos.find((p) => p.mediaId === mediaId);
    if (photo) router.push(`/photo/${photo.id}`);
    else showToast("Photo not synced yet — pull to refresh the project.");
  };

  if (!task) {
    // Deleted while open, or a stale deep link.
    return (
      <View
        style={[
          styles.wrap,
          { backgroundColor: colors.background, paddingTop: insets.top + 8 },
        ]}
      >
        <Header title="Task" onBack={() => router.back()} colors={colors} />
        <View style={{ flex: 1, justifyContent: "center" }}>
          <EmptyState
            icon="check-square"
            title="Task not found"
            description="This task may have been deleted."
          />
        </View>
      </View>
    );
  }

  const required = task.requiredPhotoCount ?? 0;
  const attached = rows.length;
  const requirementUnmet = !task.done && attached < required;
  const dueLabel = formatDueLabel(task.dueDate);
  const isPast = matchesDueFilter(task.dueDate, "past") && !task.done;

  return (
    <View
      style={[
        styles.wrap,
        { backgroundColor: colors.background, paddingTop: insets.top + 8 },
      ]}
    >
      <Header title="Task" onBack={() => router.back()} colors={colors} />

      <ScrollView
        contentContainerStyle={{
          padding: 20,
          paddingBottom: insets.bottom + 120,
          gap: 16,
        }}
      >
        {/* Status + title + notes */}
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: "row" }}>
            <TaskStatusPill
              status={task.status ?? "todo"}
              onPress={() => {
                Haptics.selectionAsync().catch(() => {});
                cycleTaskStatus(task.id).catch(() => {});
              }}
            />
          </View>
          <Text style={[styles.title, { color: colors.foreground }]}>
            {task.title}
          </Text>
          {task.notes ? (
            <Text style={[styles.notes, { color: colors.mutedForeground }]}>
              {task.notes}
            </Text>
          ) : null}
        </View>

        {/* Meta card: project / assignee / due date */}
        <View
          style={[
            styles.card,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <MetaRow
            icon="folder"
            label="Project"
            value={project?.name ?? "Project"}
            colors={colors}
          />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <MetaRow
            icon={task.assignedToName ? "user" : "user-x"}
            label="Assignee"
            value={task.assignedToName ?? "Unassigned"}
            muted={!task.assignedToName}
            onPress={() => setReassignOpen(true)}
            colors={colors}
          />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <MetaRow
            icon="calendar"
            label="Due"
            value={dueLabel ?? "No due date"}
            muted={!dueLabel}
            valueColor={isPast ? "#DC2626" : undefined}
            colors={colors}
          />
        </View>

        {/* Photos section */}
        <View style={{ gap: 10 }}>
          <View style={styles.photosHeader}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
              Photos
            </Text>
            {required > 0 ? (
              <Text
                style={[
                  styles.requirementHint,
                  {
                    color: requirementUnmet ? "#D97706" : colors.mutedForeground,
                  },
                ]}
              >
                {`${attached} of ${required} required photo${required === 1 ? "" : "s"} attached`}
              </Text>
            ) : null}
          </View>

          {loading ? (
            <View style={styles.photosFill}>
              <ActivityIndicator color={colors.mutedForeground} />
            </View>
          ) : loadError ? (
            <View style={styles.photosFill}>
              <Text
                style={{ color: colors.mutedForeground, textAlign: "center" }}
              >
                {loadError}
              </Text>
              <Button
                title="Retry"
                variant="secondary"
                onPress={retryLoad}
                style={{ marginTop: 12 }}
              />
            </View>
          ) : rows.length === 0 ? (
            <View style={styles.photosFill}>
              <Feather name="camera" size={24} color={colors.mutedForeground} />
              <Text
                style={{
                  color: colors.mutedForeground,
                  textAlign: "center",
                  marginTop: 8,
                  fontFamily: "Inter_400Regular",
                  fontSize: 13,
                }}
              >
                No photos attached to this task yet.
              </Text>
            </View>
          ) : (
            <View style={styles.grid}>
              {rows.map((r) => (
                <View key={String(r.id)} style={styles.tile}>
                  <Pressable
                    onPress={() => openPhoto(r.mediaId)}
                    style={({ pressed }) => [
                      { flex: 1, opacity: pressed ? 0.8 : 1 },
                    ]}
                    accessibilityRole="imagebutton"
                    accessibilityLabel="View photo"
                  >
                    <Image
                      source={{ uri: r.media?.url }}
                      style={[styles.tileImg, { backgroundColor: colors.muted }]}
                      contentFit="cover"
                    />
                  </Pressable>
                  <Pressable
                    onPress={() => detach(r)}
                    hitSlop={8}
                    disabled={busy}
                    style={styles.removeBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Remove photo from task"
                  >
                    <Feather name="x" size={13} color="#FFFFFF" />
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          <View style={{ flexDirection: "row", gap: 10 }}>
            <Button
              title="Take photo"
              variant="secondary"
              onPress={takeNewPhoto}
              disabled={busy}
              style={{ flex: 1 }}
            />
            <Button
              title="Attach photos"
              variant="secondary"
              onPress={() => setPickerOpen(true)}
              loading={busy}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      </ScrollView>

      {/* Mark done — pinned footer. Same guarded path as the pill cycle
          (setTaskStatus), including the 422 PHOTOS_REQUIRED alert. */}
      {!task.done ? (
        <View
          style={[
            styles.footer,
            {
              paddingBottom: insets.bottom + 12,
              borderTopColor: colors.border,
              backgroundColor: colors.background,
            },
          ]}
        >
          <Button
            title="Mark done"
            size="lg"
            loading={markingDone}
            onPress={() => {
              Haptics.selectionAsync().catch(() => {});
              setMarkingDone(true);
              setTaskStatus(task.id, "done")
                .catch(() => {})
                .finally(() => setMarkingDone(false));
            }}
          />
        </View>
      ) : null}

      <PhotoPickerModal
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        projectId={task.projectId}
        alreadyAttachedMediaIds={attachedMediaIds}
        onAttachMediaIds={attach}
      />

      {reassignOpen ? (
        <AssigneePickerSheet
          visible
          projectId={task.projectId}
          selectedUserId={task.assignedToId ?? null}
          onClose={() => setReassignOpen(false)}
          onSelect={onReassign}
        />
      ) : null}
    </View>
  );
}

function Header({
  title,
  onBack,
  colors,
}: {
  title: string;
  onBack: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={[styles.header, { borderBottomColor: colors.border }]}>
      <Pressable
        onPress={onBack}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Back"
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <Feather name="arrow-left" size={22} color={colors.foreground} />
      </Pressable>
      <Text style={[styles.headerTitle, { color: colors.foreground }]}>
        {title}
      </Text>
      <View style={{ width: 22 }} />
    </View>
  );
}

function MetaRow({
  icon,
  label,
  value,
  muted,
  valueColor,
  onPress,
  colors,
}: {
  icon: React.ComponentProps<typeof Feather>["name"];
  label: string;
  value: string;
  muted?: boolean;
  valueColor?: string;
  onPress?: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  const inner = (
    <View style={styles.metaRow}>
      <Feather name={icon} size={14} color={colors.mutedForeground} />
      <Text style={[styles.metaLabel, { color: colors.mutedForeground }]}>
        {label}
      </Text>
      <Text
        style={[
          styles.metaValue,
          {
            color:
              valueColor ?? (muted ? colors.mutedForeground : colors.foreground),
          },
        ]}
        numberOfLines={1}
      >
        {value}
      </Text>
      {onPress ? (
        <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
      ) : null}
    </View>
  );
  if (!onPress) return inner;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}. Tap to change.`}
    >
      {inner}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 17, fontFamily: "Inter_600SemiBold" },
  title: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.4,
  },
  notes: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
  card: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
  },
  divider: { height: StyleSheet.hairlineWidth },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 13,
  },
  metaLabel: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    width: 70,
  },
  metaValue: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  photosHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 10,
  },
  sectionTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold" },
  requirementHint: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    flexShrink: 1,
    textAlign: "right",
  },
  photosFill: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 28,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: TILE_GAP,
  },
  tile: {
    width: `${100 / TILES_PER_ROW - 1}%`,
    aspectRatio: 1,
    borderRadius: 8,
    overflow: "hidden",
  },
  tileImg: { width: "100%", height: "100%" },
  removeBtn: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
  },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 12,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
