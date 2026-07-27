import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Alert, AppState } from "react-native";

import { useAuth } from "@/contexts/AuthContext";
import { ApiError, api } from "@/services/api";
import { newId } from "@/services/id";
import {
  mapBackendMedia,
  mapBackendProject,
  mapBackendTask,
} from "@/services/mappers";
import { toCanonicalForSave, hasCanvasMeta } from "@/services/annotations";
import { storage } from "@/services/storage";
import type {
  Photo,
  Project,
  StoredStroke,
  Task,
  TaskPriority,
  TaskStatus,
} from "@/services/types";
import {
  clearAll as clearUploadQueueAll,
  enqueueUpload,
  removeItem as removeUploadQueueItem,
  subscribe as subscribeUploadQueue,
} from "@/services/uploadQueue";

/** Shape callers pass to addPhoto/addPhotosBatch. The optional upload-meta
 *  fields trigger background enqueue when all three are present.
 *  `checklistItemId` (optional) tags the resulting upload so the upload
 *  queue's post-upload tagger attaches the new media to that checklist
 *  item once it lands server-side. */
type AddPhotoInput = Omit<Photo, "id" | "uploaded" | "uploadQueueId"> & {
  originalName?: string;
  mimeType?: string;
  fileSize?: number;
  checklistItemId?: string;
};

interface DataState {
  projects: Project[];
  photos: Photo[];
  tasks: Task[];
  ready: boolean;
  syncing: boolean;
  syncError: string | null;

  /** Re-sync projects + tasks from the backend (pass `{force:true}` to bypass throttling). */
  refresh: (opts?: { force?: boolean }) => Promise<void>;

  /** Load a single project's detail (photos + tasks) into state. Checklists
   *  are loaded separately via the useProjectChecklists hook (server-backed). */
  loadProjectDetail: (id: string) => Promise<void>;

  createProject: (
    input: Pick<Project, "name" | "address" | "client"> & {
      latitude?: number | null;
      longitude?: number | null;
    },
  ) => Promise<Project>;
  updateProject: (id: string, patch: Partial<Project>) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;

  addPhoto: (input: AddPhotoInput) => Promise<Photo>;
  addPhotosBatch: (inputs: AddPhotoInput[]) => Promise<Photo[]>;
  deletePhoto: (id: string) => Promise<void>;
  updatePhoto: (id: string, patch: Partial<Photo>) => Promise<void>;

  /**
   * Fetch the server-side annotation rows for a photo (one per user) and
   * make the server the source of truth on open. Updates the photo's
   * render-set union (Photo.annotations) and returns the split the editor
   * needs: the current user's OWN editable strokes vs. everyone else's.
   * No-op (returns empty/own-only) for photos without a server mediaId.
   */
  loadPhotoAnnotations: (
    photoId: string,
  ) => Promise<{ ownStrokes: StoredStroke[]; othersStrokes: StoredStroke[] }>;
  /**
   * Persist the current user's OWN strokes for a photo. Writes to the
   * server (PUT existing row / POST new row, keyed by Photo.mediaId) and
   * updates the local render-set union. For not-yet-uploaded local photos
   * it persists locally only (server flush deferred to upload).
   */
  saveAnnotations: (
    photoId: string,
    ownStrokes: StoredStroke[],
  ) => Promise<boolean>;

  /**
   * Create a server-backed task. The optimistic row is prepended with
   * a synthetic `tmp-...` id and replaced with the server row on
   * success. On failure the optimistic row is removed and the error
   * re-thrown so the caller can show a toast.
   */
  createTask: (
    projectId: string,
    input: {
      title: string;
      description?: string;
      priority?: TaskPriority;
      assignedToId?: string | null;
      /** Optimistic display name; preserved if the POST response omits the join. */
      assignedToName?: string;
      dueDate?: string;
      /**
       * Photo requirement. Admin-only on the server (silently stripped
       * for non-admins); clamped to integer 0-100 before sending.
       * undefined / 0 = no requirement.
       */
      requiredPhotoCount?: number;
    },
  ) => Promise<Task>;
  /**
   * Patch any subset of mutable fields on an existing task. Optimistic
   * merge → PATCH → replace with server response. On failure the
   * pre-patch row is restored and the error re-thrown.
   *
   * Pass `null` to explicitly clear assignedToId / dueDate / priority /
   * description. Omitted fields are unchanged.
   */
  updateTask: (
    id: string,
    patch: {
      title?: string;
      description?: string | null;
      status?: TaskStatus;
      priority?: TaskPriority | null;
      assignedToId?: string | null;
      assignedToName?: string | null;
      dueDate?: string | null;
    },
  ) => Promise<void>;
  /**
   * Advance a task's status one step in the web-matching cycle
   * todo → in_progress → done → todo via updateTask({status}). Replaces
   * the old binary done-toggle so mobile can both SET and PRESERVE
   * in_progress (a binary toggle silently jumped in_progress → done).
   */
  cycleTaskStatus: (id: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;

  /** Wipe all local data (used by account-deletion / leave-team flows). */
  clearAll: () => Promise<void>;
}

const DataContext = createContext<DataState | undefined>(undefined);

/** Merge backend items into an array keyed by id, preserving any local-only rows. */
/**
 * Clamp a task photo requirement to the server's validation range —
 * integer 0..100 — so a bad value can never 400 a create/patch.
 */
function clampPhotoRequirement(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.floor(n)));
}

function mergeById<T extends { id: string; remote?: boolean }>(
  existing: T[],
  incoming: T[],
): T[] {
  const incomingIds = new Set(incoming.map((i) => i.id));
  // Keep existing rows that (a) are local-only (no `remote` flag) AND (b) not
  // superseded by an incoming row with the same id.
  const localKept = existing.filter(
    (e) => !e.remote && !incomingIds.has(e.id),
  );
  return [...incoming, ...localKept];
}

export function DataProvider({ children }: { children: React.ReactNode }) {
  const { user, ready: authReady } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [ready, setReady] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Hydrate local cache on first mount so the app works offline immediately.
  // Tasks are intentionally NOT hydrated from disk — they're server-only
  // since the v2 rewrite (2026-05) and the legacy @fv/tasks key is purged
  // by pruneLegacyKeys(). Initial render shows an empty list until the
  // first refresh() lands.
  useEffect(() => {
    (async () => {
      storage.pruneLegacyKeys();
      const [p, ph] = await Promise.all([
        storage.getProjects(),
        storage.getPhotos(),
      ]);
      setProjects(p);
      photosRef.current = ph;
      setPhotos(ph);
      setReady(true);
    })();
  }, []);

  const persistProjects = useCallback(async (next: Project[]) => {
    setProjects(next);
    await storage.setProjects(next);
  }, []);
  // Single write path for photos: the ref is updated here (synchronously,
  // before any await) so concurrent mutators reading photosRef.current
  // always see the latest write — React state commits lag behind and a
  // per-render `photosRef.current = photos` assignment could reset the
  // ref to a stale array between a write and its commit.
  const photosRef = useRef<Photo[]>([]);
  const persistPhotos = useCallback(async (next: Photo[]) => {
    photosRef.current = next;
    setPhotos(next);
    await storage.setPhotos(next);
  }, []);
  // Tasks are server-only: no persistence layer, just in-memory state.
  // Wrapper kept (instead of inlining setTasks everywhere) so callers
  // read symmetrically with persistProjects / persistPhotos.
  const setTasksList = useCallback((next: Task[]) => {
    setTasks(next);
  }, []);

  // --- Backend sync ---
  // Refs let our sync callbacks read current state without being recreated
  // every time the state changes (avoids effect re-runs / fetch loops).
  const projectsRef = useRef(projects);
  const tasksRef = useRef(tasks);
  const userRef = useRef(user);
  projectsRef.current = projects;
  tasksRef.current = tasks;
  userRef.current = user;

  // Annotation bookkeeping, keyed by String(mediaId):
  //  - annotationRowIdRef:  the current user's OWN annotation row id, so a
  //    save can PUT (update) instead of POST (create a duplicate row).
  //  - annotationOthersRef: the union of OTHER users' strokes, kept so the
  //    render set (Photo.annotations) can be recomposed after an own-row
  //    save without re-fetching every collaborator.
  const annotationRowIdRef = useRef<Record<string, string>>({});
  const annotationOthersRef = useRef<Record<string, StoredStroke[]>>({});

  // Throttle + dedupe refreshes triggered from many places (auth ready, app
  // foreground, screen focus, manual pull-to-refresh).
  const syncingRef = useRef(false);
  const lastSyncRef = useRef(0);

  // Per-task version counter — mirrors the useChecklistDetail pattern.
  // Bumped on every local write to a given task id; the response handler
  // checks the version is unchanged before applying server data, so a
  // slow PATCH that returns AFTER a faster newer write doesn't clobber
  // the newer state. Optimistic-create (tmp- ids) doesn't use this map.
  const taskVersionsRef = useRef<Map<string, number>>(new Map());
  /** Task ids with a status-cycle PATCH currently in flight (see cycleTaskStatus). */
  const cyclingTasksRef = useRef<Set<string>>(new Set());
  const bumpTaskVersion = useCallback((id: string): number => {
    const next = (taskVersionsRef.current.get(id) ?? 0) + 1;
    taskVersionsRef.current.set(id, next);
    return next;
  }, []);
  const getTaskVersion = useCallback((id: string): number => {
    return taskVersionsRef.current.get(id) ?? 0;
  }, []);

  const doSync = useCallback(async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const [backendProjects, backendTasks] = await Promise.all([
        api.projects(),
        api.tasks().catch(() => [] as []),
      ]);
      const mappedProjects = Array.isArray(backendProjects)
        ? backendProjects.map(mapBackendProject)
        : [];
      const mappedTasks = Array.isArray(backendTasks)
        ? backendTasks.map(mapBackendTask)
        : [];
      await persistProjects(mergeById(projectsRef.current, mappedProjects));
      setTasksList(mergeById(tasksRef.current, mappedTasks));
      lastSyncRef.current = Date.now();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return false;
      setSyncError(e instanceof Error ? e.message : "Sync failed");
      return false;
    } finally {
      setSyncing(false);
    }
  }, [persistProjects, setTasksList]);

  const refresh = useCallback(
    async (opts?: { force?: boolean }) => {
      if (syncingRef.current) return;
      // Throttle background refreshes to once every 4s; manual pulls bypass.
      if (
        !opts?.force &&
        Date.now() - lastSyncRef.current < 4000 &&
        lastSyncRef.current !== 0
      ) {
        return;
      }
      syncingRef.current = true;
      try {
        const ok = await doSync();
        // Transient failure on a fresh app start? Try once more after a short
        // backoff. This fixes the "had to pull-down to load" issue when the
        // session cookie wasn't ready on the first call.
        if (!ok && lastSyncRef.current === 0) {
          await new Promise((r) => setTimeout(r, 1500));
          await doSync();
        }
      } finally {
        syncingRef.current = false;
      }
    },
    [doSync],
  );

  // Re-sync whenever the authenticated user changes.
  useEffect(() => {
    if (!authReady || !ready) return;
    if (!user) {
      setSyncError(null);
      lastSyncRef.current = 0;
      return;
    }
    refresh({ force: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, ready, user?.id]);

  // Re-sync when the app comes back to the foreground.
  useEffect(() => {
    if (!authReady || !ready) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && user) refresh();
    });
    return () => sub.remove();
  }, [authReady, ready, user, refresh]);

  const loadProjectDetail = useCallback(
    async (id: string) => {
      if (!user) return;
      // Only fetch detail for projects that originated from the backend.
      // Locally-created projects use nanoid-style ids and would 404.
      const existing = projectsRef.current.find((p) => p.id === id);
      if (!existing?.remote) return;
      try {
        const detail = await api.project(id);
        if (!detail?.project) return;
        const mappedProject = mapBackendProject(detail.project);
        const idStr = String(mappedProject.id);
        // Single-row upsert. DO NOT use mergeById here: mergeById assumes
        // `incoming` is the FULL backend list and drops every remote row
        // that's missing from it. Calling it with a one-element array
        // (just this project) silently wipes every other remote project
        // from in-memory state AND AsyncStorage, producing the "list shows
        // only the project I came from" bug after navigating back.
        const existingProjects = projectsRef.current;
        const upserted = existingProjects.some((p) => p.id === mappedProject.id)
          ? existingProjects.map((p) =>
              p.id === mappedProject.id ? mappedProject : p,
            )
          : [mappedProject, ...existingProjects];
        await persistProjects(upserted);
        // Always replace remote photos for this project (even with empty list,
        // so stale deletions on the web propagate); keep local-only rows.
        console.log("[photos] received from backend:", detail.media?.length ?? 0);
        // Carry over any annotations already loaded for these media. The
        // project detail GET does NOT include annotation rows (they're
        // fetched per-media on photo open), so a naive remap would wipe the
        // render set on every refresh. Preserve the previously-fetched
        // strokes by media id.
        const mappedMedia = (detail.media ?? []).map(mapBackendMedia).map((m) => {
          const prev = photosRef.current.find((p) => p.id === m.id);
          return prev?.annotations ? { ...m, annotations: prev.annotations } : m;
        });
        console.log("[photos] after mapping:", mappedMedia.length);
        const keptLocalPhotos = photosRef.current.filter(
          (p) => !(p.remote && p.projectId === idStr),
        );
        console.log("[photos] kept local:", keptLocalPhotos.length);
        console.log("[photos] total after persist:", (mappedMedia.length + keptLocalPhotos.length));
        await persistPhotos([...mappedMedia, ...keptLocalPhotos]);
        // Always replace remote tasks for this project (even with empty list,
        // so server-side deletions propagate); keep tasks for other projects
        // and local-only tmp- rows for this project that are still mid-create.
        // DO NOT use mergeById here — it assumes `incoming` is the FULL
        // backend list and would drop every remote task from other projects.
        const mappedTasks = (detail.tasks ?? []).map(mapBackendTask);
        const keptOtherTasks = tasksRef.current.filter(
          (t) => t.projectId !== idStr,
        );
        const keptLocalTasksForProject = tasksRef.current.filter(
          (t) => t.projectId === idStr && !t.remote,
        );
        setTasksList([
          ...keptOtherTasks,
          ...mappedTasks,
          ...keptLocalTasksForProject,
        ]);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return; // silently ignore
        if (!(e instanceof ApiError && e.status === 401)) {
          setSyncError(
            e instanceof Error ? e.message : "Failed to load project",
          );
        }
      }
    },
    [user, persistProjects, persistPhotos, setTasksList],
  );

  const createProject: DataState["createProject"] = useCallback(
    async (input) => {
      const backend = await api.createProject({
        name: input.name.trim(),
        address: input.address.trim() || null,
        description: input.client.trim() || null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
      });
      const p = mapBackendProject(backend);
      await persistProjects([p, ...projectsRef.current]);
      return p;
    },
    [persistProjects],
  );

  const updateProject: DataState["updateProject"] = useCallback(
    async (id, patch) => {
      const numId = Number(id);
      if (!Number.isFinite(numId)) {
        throw new Error(`Cannot update project with non-numeric id "${id}"`);
      }
      const apiPatch: Record<string, unknown> = {};
      if (patch.name !== undefined) apiPatch.name = patch.name;
      if (patch.address !== undefined) apiPatch.address = patch.address || null;
      if (patch.client !== undefined) apiPatch.description = patch.client || null;
      if (patch.latitude !== undefined) apiPatch.latitude = patch.latitude ?? null;
      if (patch.longitude !== undefined) apiPatch.longitude = patch.longitude ?? null;
      if (patch.color !== undefined) apiPatch.color = patch.color || null;
      if (patch.tags !== undefined) apiPatch.tags = patch.tags;
      if (patch.status !== undefined) apiPatch.status = patch.status;
      const backend = await api.updateProject(numId, apiPatch);
      const updated = mapBackendProject(backend);
      const next = projectsRef.current.map((p) =>
        p.id === updated.id ? updated : p,
      );
      await persistProjects(next);
    },
    [persistProjects],
  );

  const deleteProject: DataState["deleteProject"] = useCallback(
    async (id) => {
      // Server is the source of truth: delete remotely FIRST. On a
      // non-2xx (e.g. 403 permission, 409 "has time entries") apiFetch
      // throws an ApiError, we skip the local prune, and the error
      // propagates to the caller's catch so the UI can surface it.
      // Without this the old local-only prune silently reverted on the
      // next sync (mergeById re-added the still-present server row).
      await api.deleteProject(id);
      await persistProjects(projects.filter((p) => p.id !== id));
      await persistPhotos(photos.filter((p) => p.projectId !== id));
      setTasksList(tasks.filter((t) => t.projectId !== id));
    },
    [
      projects,
      photos,
      tasks,
      persistProjects,
      persistPhotos,
      setTasksList,
    ],
  );

  const addPhoto: DataState["addPhoto"] = useCallback(
    async (input) => {
      const { originalName, mimeType, fileSize, checklistItemId, ...photoFields } =
        input;
      let uploadQueueId: string | undefined;
      if (
        originalName &&
        mimeType &&
        typeof fileSize === "number" &&
        fileSize > 0
      ) {
        try {
          const queued = await enqueueUpload({
            localUri: input.uri,
            projectId: input.projectId,
            originalName,
            mimeType,
            fileSize,
            latitude: input.latitude,
            longitude: input.longitude,
            checklistItemId,
          });
          uploadQueueId = queued.id;
        } catch (e) {
          console.log("[DataContext] enqueueUpload failed:", e);
        }
      }
      const photo: Photo = {
        ...photoFields,
        id: newId(),
        uploaded: false,
        uploadQueueId,
      };
      // Read through photosRef, NOT the `photos` closure: two saves
      // landing before a re-render (e.g. burst finishing while a single
      // capture saves) would otherwise each spread a stale array and the
      // second would overwrite the first's photo out of state.
      const next = [photo, ...photosRef.current];
      await persistPhotos(next);
      return photo;
    },
    [persistPhotos],
  );

  const addPhotosBatch: DataState["addPhotosBatch"] = useCallback(
    async (inputs) => {
      const queueIds = await Promise.all(
        inputs.map(async (i) => {
          if (
            i.originalName &&
            i.mimeType &&
            typeof i.fileSize === "number" &&
            i.fileSize > 0
          ) {
            try {
              const queued = await enqueueUpload({
                localUri: i.uri,
                projectId: i.projectId,
                originalName: i.originalName,
                mimeType: i.mimeType,
                fileSize: i.fileSize,
                latitude: i.latitude,
                longitude: i.longitude,
                checklistItemId: i.checklistItemId,
              });
              return queued.id;
            } catch (e) {
              console.log("[DataContext] enqueueUpload failed:", e);
              return undefined;
            }
          }
          return undefined;
        }),
      );
      const created: Photo[] = inputs.map((i, idx) => {
        const { originalName, mimeType, fileSize, checklistItemId, ...photoFields } =
          i;
        void originalName;
        void mimeType;
        void fileSize;
        void checklistItemId;
        return {
          ...photoFields,
          id: newId(),
          uploaded: false,
          uploadQueueId: queueIds[idx],
        };
      });
      // photosRef (not the `photos` closure) — see addPhoto: concurrent
      // saves must not clobber each other.
      const next = [...created, ...photosRef.current];
      await persistPhotos(next);
      return created;
    },
    [persistPhotos],
  );

  // Reconcile photos with successful background uploads. The queue stores
  // uploadedUrl on success; we swap the local cache uri for the CloudFront
  // url on the matching local Photo (matched by uploadQueueId) and remove
  // the queue item so it doesn't accumulate.
  const reconciledQueueIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const unsub = subscribeUploadQueue((queue) => {
      const uploaded = queue.filter(
        (it) =>
          it.status === "uploaded" &&
          it.uploadedUrl &&
          !reconciledQueueIdsRef.current.has(it.id),
      );
      if (uploaded.length === 0) return;

      let next = photosRef.current;
      let changed = false;
      for (const item of uploaded) {
        reconciledQueueIdsRef.current.add(item.id);
        const url = item.uploadedUrl as string;
        const idx = next.findIndex((p) => p.uploadQueueId === item.id);
        if (idx === -1) {
          // No matching local photo — possibly deleted, or app restarted.
          // Just garbage-collect the queue item.
          removeUploadQueueItem(item.id).catch(() => {});
          continue;
        }
        next = next.map((p, i) =>
          i === idx
            ? {
                ...p,
                uri: url,
                remoteUrl: url,
                uploaded: true,
                remote: true,
                // Persist the server media id so consumers (e.g. the
                // checklist photo-picker) can reference this photo by its
                // server identity even before a full project refetch
                // remaps `id`. We intentionally keep `id` as the local
                // UUID so list keys stay stable.
                mediaId:
                  typeof item.uploadedMediaId === "number"
                    ? item.uploadedMediaId
                    : p.mediaId,
              }
            : p,
        );
        changed = true;
        console.log(
          `[DataContext] reconciled photo ${next[idx].id} ← queue ${item.id}`,
        );
        removeUploadQueueItem(item.id).catch(() => {});
      }
      if (changed) {
        void persistPhotos(next);
      }
    });
    return unsub;
  }, [persistPhotos]);

  const deletePhoto: DataState["deletePhoto"] = useCallback(
    async (id) => {
      // If the photo had a pending background upload, cancel it first so the
      // queue doesn't keep retrying a file we've thrown away.
      const photo = photos.find((p) => p.id === id);
      if (photo?.uploadQueueId) {
        removeUploadQueueItem(photo.uploadQueueId).catch(() => {});
      }
      await persistPhotos(photos.filter((p) => p.id !== id));
    },
    [photos, persistPhotos],
  );

  const updatePhoto: DataState["updatePhoto"] = useCallback(
    async (id, patch) => {
      await persistPhotos(
        photos.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      );
    },
    [photos, persistPhotos],
  );

  const loadPhotoAnnotations: DataState["loadPhotoAnnotations"] = useCallback(
    async (photoId) => {
      const photo = photosRef.current.find((p) => p.id === photoId);
      // Local (not-yet-uploaded) photo: nothing lives on the server. Its
      // own strokes are whatever we persisted locally in Photo.annotations.
      if (!photo || photo.mediaId == null) {
        return { ownStrokes: photo?.annotations ?? [], othersStrokes: [] };
      }

      const mediaKey = String(photo.mediaId);
      // Legacy local own strokes (px, carry canvasW/H) cached before this
      // build — preserved so a first save uploads them (requirement #3).
      const legacyOwn = (photo.annotations ?? []).filter(hasCanvasMeta);

      let rows;
      try {
        rows = await api.listMediaAnnotations(photo.mediaId);
        // TEMP DIAG (Bug 2, build 39): raw response shape + stroke counts.
        console.log(
          `[annot-diag] GET annotations media=${photo.mediaId}: rows=${Array.isArray(rows) ? rows.length : typeof rows}`,
          Array.isArray(rows)
            ? rows.map((r) => ({
                id: r.id,
                userId: r.userId,
                strokes: Array.isArray(r.strokes) ? r.strokes.length : "n/a",
                types: Array.isArray(r.strokes)
                  ? r.strokes.map((s: { type?: unknown }) => s?.type)
                  : [],
              }))
            : rows,
        );
      } catch (err) {
        // TEMP DIAG (Bug 2, build 39): this catch previously swallowed the
        // error with zero logging — a session drop (Bug 1) lands here and
        // looks identical to "no annotations".
        console.warn(
          `[annot-diag] GET annotations media=${photo.mediaId} FAILED:`,
          err instanceof ApiError ? `ApiError status=${err.status}` : err,
          `→ falling back to legacyOwn=${legacyOwn.length}, others=0`,
        );
        // Tolerant: keep whatever we have rather than blanking the photo.
        return { ownStrokes: legacyOwn, othersStrokes: [] };
      }

      const uid = userRef.current?.id;
      const others: StoredStroke[] = [];
      let ownStrokes: StoredStroke[] = [];
      let ownRowId: string | undefined;
      for (const row of rows ?? []) {
        const strokes = Array.isArray(row.strokes) ? row.strokes : [];
        if (uid != null && String(row.userId) === String(uid)) {
          ownStrokes = strokes;
          ownRowId = String(row.id);
        } else {
          others.push(...strokes);
        }
      }

      // Keep the cached own-row id in lockstep with the server. Clearing it
      // when the server has no row for us prevents saveAnnotations from
      // PUT-ing forever against a stale/deleted row id (it falls back to POST).
      if (ownRowId) annotationRowIdRef.current[mediaKey] = ownRowId;
      else delete annotationRowIdRef.current[mediaKey];
      annotationOthersRef.current[mediaKey] = others;
      // If the server has no row for us yet, fall back to any legacy local
      // own strokes so they survive until the user's next save uploads them.
      if (!ownRowId && legacyOwn.length) ownStrokes = legacyOwn;

      await persistPhotos(
        photosRef.current.map((p) =>
          p.id === photoId
            ? { ...p, annotations: [...others, ...ownStrokes] }
            : p,
        ),
      );
      return { ownStrokes, othersStrokes: others };
    },
    [persistPhotos],
  );

  const saveAnnotations: DataState["saveAnnotations"] = useCallback(
    async (photoId, ownStrokes) => {
      const photo = photosRef.current.find((p) => p.id === photoId);
      if (!photo) return false;

      // Canonicalize the FULL own-row payload — including non-pencil strokes
      // the mobile renderer can't draw. Never strip types from the save.
      const canonical = ownStrokes.map(toCanonicalForSave);

      // No server media yet → persist locally and defer the server flush.
      // Returns true (locally saved is all we can do): there is no server row
      // to create, so callers should NOT keep this photo dirty for retry. The
      // post-upload push remains a separate, unimplemented concern.
      if (photo.mediaId == null) {
        // TODO(flush-on-upload): when this local photo finishes uploading
        // and gets a mediaId, push these annotations to the server.
        await persistPhotos(
          photosRef.current.map((p) =>
            p.id === photoId ? { ...p, annotations: canonical } : p,
          ),
        );
        return true;
      }

      const mediaId = photo.mediaId;
      const mediaKey = String(mediaId);

      // Persist the optimistic local union first, independent of the server
      // result, so the UI reflects the edit even if the network write fails.
      const others = annotationOthersRef.current[mediaKey] ?? [];
      await persistPhotos(
        photosRef.current.map((p) =>
          p.id === photoId
            ? { ...p, annotations: [...others, ...canonical] }
            : p,
        ),
      );

      // Server write. Self-heals a stale/invalid own-row id: a failed PUT
      // drops the cached id and falls back to POST so a remotely-deleted row
      // can't permanently block syncing. Row id is cached only on success.
      // Returns whether the server actually accepted the write so the caller
      // can keep the photo dirty and retry on failure (no silent data loss).
      const existingId = annotationRowIdRef.current[mediaKey];
      try {
        if (existingId) {
          try {
            const row = await api.updateAnnotation(existingId, canonical);
            if (row?.id) annotationRowIdRef.current[mediaKey] = String(row.id);
          } catch {
            delete annotationRowIdRef.current[mediaKey];
            const row = await api.createMediaAnnotation(mediaId, canonical);
            if (row?.id) annotationRowIdRef.current[mediaKey] = String(row.id);
          }
        } else {
          const row = await api.createMediaAnnotation(mediaId, canonical);
          if (row?.id) annotationRowIdRef.current[mediaKey] = String(row.id);
        }
        return true;
      } catch {
        // Tolerant: optimistic local state already persisted above; signal
        // failure so the caller keeps the dirty flag and retries later.
        return false;
      }
    },
    [persistPhotos],
  );

  const createTask: DataState["createTask"] = useCallback(
    async (projectId, input) => {
      const tmpId = `tmp-${newId()}`;
      const trimmedTitle = input.title.trim();
      const trimmedDesc = input.description?.trim() || undefined;
      const optimistic: Task = {
        id: tmpId,
        projectId,
        title: trimmedTitle,
        notes: trimmedDesc,
        done: false,
        status: "todo",
        priority: input.priority,
        assignedToId: input.assignedToId ?? undefined,
        assignedToName: input.assignedToName,
        dueDate: input.dueDate,
        requiredPhotoCount:
          input.requiredPhotoCount && input.requiredPhotoCount > 0
            ? clampPhotoRequirement(input.requiredPhotoCount)
            : undefined,
        createdAt: new Date().toISOString(),
        // Intentionally NOT remote=true — the row is local until the
        // POST resolves. mergeById preserves it across refreshes during
        // that window.
      };
      setTasksList([optimistic, ...tasksRef.current]);
      try {
        const backend = await api.createTask(projectId, {
          title: trimmedTitle,
          description: trimmedDesc ?? null,
          priority: input.priority ?? null,
          assignedToId: input.assignedToId ?? null,
          dueDate: input.dueDate ?? null,
          // Clamped to integer 0-100 client-side so a bad value can
          // never 400 the create. Omitted entirely when no requirement
          // (0 / undefined) — admin-only server-side; non-admins have
          // it silently stripped, which is fine (the field is only
          // shown to admins anyway).
          requiredPhotoCount:
            input.requiredPhotoCount && input.requiredPhotoCount > 0
              ? clampPhotoRequirement(input.requiredPhotoCount)
              : undefined,
        });
        const mapped = mapBackendTask(backend);
        // Preserve the picker-supplied display name if the server's
        // response didn't include the join, and the photo requirement
        // if the POST serializer omitted the computed task_photos
        // fields (mapBackendTask only sets it when present and > 0) —
        // otherwise the value the admin just set would vanish until
        // the next authoritative task refresh.
        const final: Task = {
          ...mapped,
          assignedToName: mapped.assignedToName ?? input.assignedToName,
          requiredPhotoCount:
            mapped.requiredPhotoCount ?? optimistic.requiredPhotoCount,
        };
        setTasksList(
          tasksRef.current.map((t) => (t.id === tmpId ? final : t)),
        );
        return final;
      } catch (err) {
        setTasksList(tasksRef.current.filter((t) => t.id !== tmpId));
        throw err;
      }
    },
    [setTasksList],
  );

  const updateTask: DataState["updateTask"] = useCallback(
    async (id, patch) => {
      const before = tasksRef.current.find((t) => t.id === id);
      if (!before) {
        throw new Error(`updateTask: no task with id "${id}"`);
      }
      // Don't try to PATCH a row that's still mid-create (no server id yet).
      if (id.startsWith("tmp-")) {
        throw new Error("Task is still being created — try again in a moment.");
      }

      const version = bumpTaskVersion(id);

      // Build the optimistic merge. `null` in patch means "clear" —
      // map that to undefined for the local Task model.
      const merged: Task = { ...before };
      if (patch.title !== undefined) merged.title = patch.title;
      if (patch.description !== undefined) {
        merged.notes = patch.description ?? undefined;
      }
      if (patch.status !== undefined) {
        merged.status = patch.status;
        merged.done = patch.status === "done";
      }
      if (patch.priority !== undefined) {
        merged.priority = patch.priority ?? undefined;
      }
      if (patch.assignedToId !== undefined) {
        merged.assignedToId = patch.assignedToId ?? undefined;
        // Clearing the id also clears the cached display name.
        if (patch.assignedToId === null) {
          merged.assignedToName = undefined;
        }
      }
      if (patch.assignedToName !== undefined) {
        merged.assignedToName = patch.assignedToName ?? undefined;
      }
      if (patch.dueDate !== undefined) {
        merged.dueDate = patch.dueDate ?? undefined;
      }
      setTasksList(
        tasksRef.current.map((t) => (t.id === id ? merged : t)),
      );

      try {
        // Wire patch — strip our local-only `assignedToName` field and
        // mirror the explicit-null semantics for clears.
        const wirePatch: Parameters<typeof api.updateTask>[1] = {};
        if (patch.title !== undefined) wirePatch.title = patch.title;
        if (patch.description !== undefined)
          wirePatch.description = patch.description;
        if (patch.status !== undefined) wirePatch.status = patch.status;
        if (patch.priority !== undefined) wirePatch.priority = patch.priority;
        if (patch.assignedToId !== undefined)
          wirePatch.assignedToId = patch.assignedToId;
        if (patch.dueDate !== undefined) wirePatch.dueDate = patch.dueDate;

        const backend = await api.updateTask(id, wirePatch);
        // A newer write came in while we were waiting — drop the
        // response so we don't clobber it.
        if (getTaskVersion(id) !== version) return;
        const mapped = mapBackendTask(backend);
        const final: Task = {
          ...mapped,
          assignedToName:
            mapped.assignedToName ??
            (patch.assignedToName !== undefined
              ? patch.assignedToName ?? undefined
              : merged.assignedToName),
        };
        setTasksList(
          tasksRef.current.map((t) => (t.id === id ? final : t)),
        );
      } catch (err) {
        // Only revert if no newer write has happened in the meantime —
        // otherwise the newer optimistic state is already correct.
        if (getTaskVersion(id) === version) {
          setTasksList(
            tasksRef.current.map((t) => (t.id === id ? before : t)),
          );
        }
        throw err;
      }
    },
    [setTasksList, bumpTaskVersion, getTaskVersion],
  );

  const cycleTaskStatus: DataState["cycleTaskStatus"] = useCallback(
    async (id) => {
      // Per-task in-flight guard. Without it, a tap while a PATCH is
      // pending reads the OPTIMISTIC status (e.g. "done" that the server
      // is about to reject with 422) and computes the next step from it —
      // advancing past "done" to "todo". With the guard, taps during the
      // round-trip are ignored, so after a rejected transition the state
      // has already been reverted and the next tap retries the SAME
      // transition.
      if (cyclingTasksRef.current.has(id)) return;
      const current = tasksRef.current.find((t) => t.id === id);
      if (!current) return;
      // Web-matching forward cycle. Falls back to "todo" as the current
      // status for any task whose status is somehow unset, so the first
      // tap always advances to "in_progress".
      const NEXT: Record<TaskStatus, TaskStatus> = {
        todo: "in_progress",
        in_progress: "done",
        done: "todo",
      };
      const nextStatus: TaskStatus = NEXT[current.status ?? "todo"];
      cyclingTasksRef.current.add(id);
      try {
        await updateTask(id, { status: nextStatus });
      } catch (err) {
        // Server-enforced photo requirement (no feature flag; live for
        // all accounts). updateTask has already reverted the optimistic
        // state, so the task is back at its pre-tap status and the next
        // tap retries the same transition. Mobile has no attach UI yet
        // (Phase 1+), so tell the crew member the actionable path.
        if (
          err instanceof ApiError &&
          err.status === 422 &&
          typeof err.body === "object" &&
          err.body !== null &&
          (err.body as { code?: unknown }).code === "PHOTOS_REQUIRED"
        ) {
          const b = err.body as { required?: number; attached?: number };
          const required = typeof b.required === "number" ? b.required : 0;
          const attached = typeof b.attached === "number" ? b.attached : 0;
          Alert.alert(
            "Photos required",
            `This task needs ${required} photo${required === 1 ? "" : "s"} attached to it before it can be completed (${attached} of ${required} attached so far).\n\nAttaching photos to a task isn't available in the app yet — please attach them from the web app, then mark the task done here.`,
          );
          return; // handled — don't propagate to the row's silent .catch
        }
        throw err;
      } finally {
        cyclingTasksRef.current.delete(id);
      }
    },
    [updateTask],
  );

  const deleteTask: DataState["deleteTask"] = useCallback(
    async (id) => {
      const before = tasksRef.current;
      const beforeIndex = before.findIndex((t) => t.id === id);
      if (beforeIndex === -1) return;
      // Local-only tmp- rows (mid-create) never made it to the server,
      // so just drop them locally.
      if (id.startsWith("tmp-")) {
        setTasksList(before.filter((t) => t.id !== id));
        return;
      }
      // Optimistic remove.
      setTasksList(before.filter((t) => t.id !== id));
      try {
        await api.deleteTask(id);
      } catch (err) {
        // Restore at original position so list ordering is preserved.
        const restored = [...tasksRef.current];
        const insertAt = Math.min(beforeIndex, restored.length);
        restored.splice(insertAt, 0, before[beforeIndex]);
        setTasksList(restored);
        throw err;
      }
    },
    [setTasksList],
  );

  const clearAll: DataState["clearAll"] = useCallback(async () => {
    // Wipe in-memory + persisted local data. Used by account-deletion and
    // leave-team flows to ensure a deleted user's data doesn't linger and
    // that the next sign-in starts from a clean slate. Ordinary sign-out
    // does NOT call this — it preserves the offline-first cache.
    await Promise.all([
      persistProjects([]),
      persistPhotos([]),
      clearUploadQueueAll().catch(() => {}),
    ]);
    setTasksList([]);
    taskVersionsRef.current.clear();
    setSyncError(null);
    lastSyncRef.current = 0;
  }, [persistProjects, persistPhotos, setTasksList]);

  const value = useMemo<DataState>(
    () => ({
      projects,
      photos,
      tasks,
      ready,
      syncing,
      syncError,
      refresh,
      loadProjectDetail,
      createProject,
      updateProject,
      deleteProject,
      addPhoto,
      addPhotosBatch,
      deletePhoto,
      updatePhoto,
      loadPhotoAnnotations,
      saveAnnotations,
      createTask,
      updateTask,
      cycleTaskStatus,
      deleteTask,
      clearAll,
    }),
    [
      projects,
      photos,
      tasks,
      ready,
      syncing,
      syncError,
      refresh,
      loadProjectDetail,
      createProject,
      updateProject,
      deleteProject,
      addPhoto,
      addPhotosBatch,
      deletePhoto,
      updatePhoto,
      loadPhotoAnnotations,
      saveAnnotations,
      createTask,
      updateTask,
      cycleTaskStatus,
      deleteTask,
      clearAll,
    ],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataState {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error("useData must be used inside DataProvider");
  return ctx;
}
