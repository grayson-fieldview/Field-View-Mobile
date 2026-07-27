import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import { useRouter } from "expo-router";

import { useData } from "@/contexts/DataContext";
import { useToast } from "@/contexts/ToastContext";
import { ApiError, api, type BackendTaskPhoto } from "@/services/api";
import { subscribeTaskAttach } from "@/services/uploadQueue";
import type { Task } from "@/services/types";

/**
 * Shared task-photo logic, lifted from the old TaskPhotosSheet so the
 * task detail screen and any future surface use ONE implementation of
 * the attach/detach flow and — critically — one copy of the count sync
 * (optimistic bump → server-authoritative reconcile). Two copies of
 * that reconcile would drift.
 *
 * Responsibilities:
 *  - Load attached rows on mount / task change (GET /api/tasks/:id/photos)
 *  - Preload the project's photos into DataContext for the picker
 *  - Live-refresh when a capture-to-task upload's attach settles
 *  - attach(mediaIds): optimistic count bump → POST → reconcile
 *  - detach(row): confirm → optimistic remove → DELETE → reconcile
 *  - takeNewPhoto(): route to /capture with projectId+taskId
 */
export function useTaskPhotos(
  task: Task | null,
  opts?: {
    /** Called right before navigating to /capture (e.g. close a modal). */
    onBeforeCapture?: () => void;
  },
) {
  const router = useRouter();
  const { showToast } = useToast();
  const { setTaskAttachedPhotoCount, loadProjectDetail } = useData();

  const [rows, setRows] = useState<BackendTaskPhoto[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const taskId = task?.id;
  const projectId = task?.projectId;
  const onBeforeCapture = opts?.onBeforeCapture;

  // Guard against cross-task stale async writes: every request is
  // scoped to the task that was active when it started. If the caller
  // has since switched tasks (or unmounted), late responses may still
  // reconcile that task's cached count (server-authoritative,
  // task-scoped anyway) but must NOT touch the local `rows`.
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

  // Load on mount / task change: attached rows (authoritative) + make
  // sure the project's photos are in DataContext for the picker — the
  // tasks tab lists tasks across projects whose media may not be loaded.
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    setRows([]);
    setLoadError(null);
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
  }, [taskId, projectId, applyRows, loadProjectDetail]);

  // Live update: when a capture-to-task upload's post-upload attach
  // settles for THIS task, pull the fresh rows so the new photo appears.
  // (DataContext owns count reconcile + failure alert; this is the grid.)
  useEffect(() => {
    if (!taskId) return;
    const unsub = subscribeTaskAttach((evt) => {
      if (evt.taskId !== taskId) return;
      refresh(taskId).catch(() => {});
    });
    return unsub;
  }, [taskId, refresh]);

  const takeNewPhoto = useCallback(() => {
    if (!taskId || !projectId) return;
    onBeforeCapture?.();
    router.push({
      pathname: "/capture",
      params: { projectId, taskId },
    });
  }, [taskId, projectId, onBeforeCapture, router]);

  const attach = useCallback(
    async (mediaIds: number[]) => {
      if (!taskId) return;
      setBusy(true);
      // Optimistic: bump the row hint immediately; reconcile below.
      setTaskAttachedPhotoCount(taskId, rows.length + mediaIds.length);
      try {
        await api.attachPhotosToTask(taskId, mediaIds);
        await refresh(taskId);
        showToast(mediaIds.length === 1 ? "Photo attached" : "Photos attached");
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

  return {
    rows,
    loading,
    loadError,
    retryLoad,
    busy,
    attach,
    detach,
    takeNewPhoto,
    attachedMediaIds: new Set(rows.map((r) => r.mediaId)),
  };
}
