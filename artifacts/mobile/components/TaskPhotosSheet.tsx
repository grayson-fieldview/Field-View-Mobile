import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { PhotoPickerModal } from "@/components/PhotoPickerModal";
import { useData } from "@/contexts/DataContext";
import { useToast } from "@/contexts/ToastContext";
import { useColors } from "@/hooks/useColors";
import { ApiError, api, type BackendTaskPhoto } from "@/services/api";
import type { Task } from "@/services/types";

interface Props {
  /** The task whose photos to manage; null = sheet closed. */
  task: Task | null;
  onClose: () => void;
}

const TILE_GAP = 8;
const TILES_PER_ROW = 3;

/**
 * Task photos sheet (Phase 1: attach existing project photos).
 *
 * Opened from the camera chip on a task row (there is no task detail
 * screen). Shows currently-attached photos (GET /api/tasks/:id/photos,
 * rows carry the joined media with a presigned url) with per-tile
 * detach, and an "Attach photos" action that opens the shared
 * PhotoPickerModal in generic mode (one bulk POST { mediaIds }).
 *
 * Count sync: after every attach/detach we optimistically update the
 * task's attachedPhotoCount from the local row list, then reconcile
 * against a fresh GET so the "N of M photos" row hints are correct
 * even if the server deduped an idempotent re-attach.
 */
export function TaskPhotosSheet({ task, onClose }: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { showToast } = useToast();
  const { setTaskAttachedPhotoCount, loadProjectDetail } = useData();

  const [rows, setRows] = useState<BackendTaskPhoto[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const visible = task !== null;
  const taskId = task?.id;
  const projectId = task?.projectId;

  // Guard against cross-task stale async writes: every request is
  // scoped to the task that was open when it started. If the sheet has
  // since closed or been reopened on a different task, late responses
  // may still reconcile that task's cached count (server-authoritative,
  // task-scoped anyway) but must NOT touch the sheet's local `rows`.
  const activeTaskIdRef = useRef<string | null>(null);
  activeTaskIdRef.current = taskId ?? null;

  const applyRows = useCallback(
    (next: BackendTaskPhoto[], forTaskId: string) => {
      setTaskAttachedPhotoCount(forTaskId, next.length);
      if (activeTaskIdRef.current === forTaskId) setRows(next);
    },
    [setTaskAttachedPhotoCount],
  );

  const refresh = useCallback(
    async (forTaskId: string) => {
      const fetched = await api.getTaskPhotos(forTaskId);
      applyRows(Array.isArray(fetched) ? fetched : [], forTaskId);
    },
    [applyRows],
  );

  const retryLoad = useCallback(() => {
    if (!taskId) return;
    setLoadError(null);
    setLoading(true);
    refresh(taskId)
      .catch((e) => {
        if (activeTaskIdRef.current === taskId)
          setLoadError(e instanceof Error ? e.message : "Couldn't load photos.");
      })
      .finally(() => {
        if (activeTaskIdRef.current === taskId) setLoading(false);
      });
  }, [taskId, refresh]);

  // Load on open: attached rows (authoritative) + make sure the
  // project's photos are in DataContext for the picker — the tasks tab
  // lists tasks across projects whose media may not be loaded yet.
  useEffect(() => {
    if (!visible || !taskId) return;
    let cancelled = false;
    setRows([]);
    setLoadError(null);
    setPickerOpen(false); // never carry an open picker across tasks
    setLoading(true);
    (async () => {
      try {
        const fetched = await api.getTaskPhotos(taskId);
        if (cancelled) return;
        applyRows(Array.isArray(fetched) ? fetched : [], taskId);
      } catch (e) {
        if (!cancelled)
          setLoadError(e instanceof Error ? e.message : "Couldn't load photos.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    if (projectId) {
      // Best-effort; the picker just shows fewer photos if this fails.
      loadProjectDetail(projectId).catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [visible, taskId, projectId, applyRows, loadProjectDetail]);

  const attach = useCallback(
    async (mediaIds: number[]) => {
      if (!taskId) return;
      setBusy(true);
      // Optimistic: bump the row hint immediately; reconcile below.
      setTaskAttachedPhotoCount(taskId, rows.length + mediaIds.length);
      try {
        await api.attachPhotosToTask(taskId, mediaIds);
        await refresh(taskId);
        showToast(
          mediaIds.length === 1 ? "Photo attached" : "Photos attached",
        );
      } catch (e) {
        // Server-authoritative count on any failure (cross-project 400 /
        // cross-account 403 are unreachable via this picker, but don't
        // crash on them — surface the message and re-sync).
        await refresh(taskId).catch(() => {
          setTaskAttachedPhotoCount(taskId, rows.length);
        });
        Alert.alert(
          "Couldn't attach photos",
          e instanceof ApiError && e.status === 400
            ? "One or more photos belong to a different project."
            : e instanceof Error
              ? e.message
              : "Please try again.",
        );
      } finally {
        setBusy(false);
      }
    },
    [taskId, rows.length, refresh, setTaskAttachedPhotoCount, showToast],
  );

  const detach = useCallback(
    (row: BackendTaskPhoto) => {
      if (!taskId) return;
      Alert.alert(
        "Remove photo from task?",
        "The photo stays in the project — it's only removed from this task.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            style: "destructive",
            onPress: async () => {
              const before = rows;
              setBusy(true);
              // Optimistic remove + count.
              applyRows(
                before.filter((r) => String(r.id) !== String(row.id)),
                taskId,
              );
              try {
                await api.detachTaskPhoto(row.id);
              } catch (e) {
                applyRows(before, taskId); // restore
                Alert.alert(
                  "Couldn't remove photo",
                  e instanceof Error ? e.message : "Please try again.",
                );
                return;
              } finally {
                setBusy(false);
              }
              // Reconcile with the server (idempotency, races).
              refresh(taskId).catch(() => {});
            },
          },
        ],
      );
    },
    [taskId, rows, applyRows, refresh],
  );

  const attachedMediaIds = new Set(rows.map((r) => r.mediaId));
  const required = task?.requiredPhotoCount ?? 0;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
    >
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <View
          style={[
            styles.header,
            { paddingTop: insets.top > 0 ? 12 : 16, borderBottomColor: colors.border },
          ]}
        >
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text
              style={[styles.headerTitle, { color: colors.foreground }]}
              numberOfLines={1}
            >
              Task photos
            </Text>
            {task ? (
              <Text
                style={[styles.headerSub, { color: colors.mutedForeground }]}
                numberOfLines={1}
              >
                {task.title}
              </Text>
            ) : null}
          </View>
          <Pressable onPress={onClose} hitSlop={10} disabled={busy}>
            <Feather name="x" size={22} color={colors.foreground} />
          </Pressable>
        </View>

        {required > 0 ? (
          <Text
            style={[
              styles.requirementHint,
              {
                color:
                  rows.length < required ? "#D97706" : colors.mutedForeground,
              },
            ]}
          >
            {`${rows.length} of ${required} required photo${required === 1 ? "" : "s"} attached`}
          </Text>
        ) : null}

        {loading ? (
          <View style={styles.centerFill}>
            <ActivityIndicator color={colors.mutedForeground} />
          </View>
        ) : loadError ? (
          <View style={styles.centerFill}>
            <Text style={{ color: colors.mutedForeground, textAlign: "center" }}>
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
          <View style={styles.centerFill}>
            <Feather name="camera" size={28} color={colors.mutedForeground} />
            <Text
              style={{
                color: colors.mutedForeground,
                textAlign: "center",
                marginTop: 10,
                fontFamily: "Inter_400Regular",
              }}
            >
              No photos attached to this task yet.
            </Text>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={{
              padding: 16,
              paddingBottom: insets.bottom + 96,
            }}
          >
            <View style={styles.grid}>
              {rows.map((r) => (
                <View key={String(r.id)} style={styles.tile}>
                  <Image
                    source={{ uri: r.media?.url }}
                    style={[styles.tileImg, { backgroundColor: colors.muted }]}
                    contentFit="cover"
                  />
                  <Pressable
                    onPress={() => detach(r)}
                    hitSlop={8}
                    disabled={busy}
                    style={styles.removeBtn}
                  >
                    <Feather name="x" size={13} color="#FFFFFF" />
                  </Pressable>
                </View>
              ))}
            </View>
          </ScrollView>
        )}

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
            title="Attach project photos"
            onPress={() => setPickerOpen(true)}
            loading={busy}
            size="lg"
          />
        </View>

        {projectId ? (
          <PhotoPickerModal
            visible={pickerOpen}
            onClose={() => setPickerOpen(false)}
            projectId={projectId}
            alreadyAttachedMediaIds={attachedMediaIds}
            onAttachMediaIds={attach}
          />
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 17, fontFamily: "Inter_600SemiBold" },
  headerSub: { fontSize: 13, fontFamily: "Inter_400Regular", marginTop: 1 },
  requirementHint: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  centerFill: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
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
