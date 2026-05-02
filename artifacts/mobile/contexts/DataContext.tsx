import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";

import { useAuth } from "@/contexts/AuthContext";
import { ApiError, api } from "@/services/api";
import { newId } from "@/services/id";
import {
  mapBackendMedia,
  mapBackendProject,
  mapBackendTask,
} from "@/services/mappers";
import { storage } from "@/services/storage";
import type {
  Checklist,
  ChecklistItem,
  Photo,
  Project,
  ShareLink,
  Task,
} from "@/services/types";
import {
  clearAll as clearUploadQueueAll,
  enqueueUpload,
  removeItem as removeUploadQueueItem,
  subscribe as subscribeUploadQueue,
} from "@/services/uploadQueue";

/** Shape callers pass to addPhoto/addPhotosBatch. The optional upload-meta
 *  fields trigger background enqueue when all three are present. */
type AddPhotoInput = Omit<Photo, "id" | "uploaded" | "uploadQueueId"> & {
  originalName?: string;
  mimeType?: string;
  fileSize?: number;
};

interface DataState {
  projects: Project[];
  photos: Photo[];
  tasks: Task[];
  checklists: Checklist[];
  shares: ShareLink[];
  ready: boolean;
  syncing: boolean;
  syncError: string | null;

  /** Re-sync projects + tasks from the backend (pass `{force:true}` to bypass throttling). */
  refresh: (opts?: { force?: boolean }) => Promise<void>;

  /** Load a single project's detail (photos + tasks + checklists) into state. */
  loadProjectDetail: (id: string) => Promise<void>;

  createProject: (
    input: Pick<Project, "name" | "address" | "client">,
  ) => Promise<Project>;
  updateProject: (id: string, patch: Partial<Project>) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;

  addPhoto: (input: AddPhotoInput) => Promise<Photo>;
  addPhotosBatch: (inputs: AddPhotoInput[]) => Promise<Photo[]>;
  deletePhoto: (id: string) => Promise<void>;
  updatePhoto: (id: string, patch: Partial<Photo>) => Promise<void>;

  createTask: (
    projectId: string,
    title: string,
    notes?: string,
    assignee?: string,
  ) => Promise<Task>;
  toggleTask: (id: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;

  createChecklist: (
    projectId: string,
    title: string,
    items: string[],
  ) => Promise<Checklist>;
  toggleChecklistItem: (
    checklistId: string,
    itemId: string,
  ) => Promise<void>;
  deleteChecklist: (id: string) => Promise<void>;

  createShare: (
    projectId: string,
    recipientEmail: string,
  ) => Promise<ShareLink>;
  revokeShare: (id: string) => Promise<void>;
  /** Wipe all local data (used by account-deletion / leave-team flows). */
  clearAll: () => Promise<void>;
}

const DataContext = createContext<DataState | undefined>(undefined);

/** Merge backend items into an array keyed by id, preserving any local-only rows. */
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
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [ready, setReady] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Hydrate local cache on first mount so the app works offline immediately.
  useEffect(() => {
    (async () => {
      // Drop orphaned cache keys from earlier schema versions (e.g. the v1
      // projects key that could be left in a truncated state by an older
      // build of loadProjectDetail). Fire-and-forget; failures are harmless.
      storage.pruneLegacyKeys();
      const [p, ph, ts, cl, sh] = await Promise.all([
        storage.getProjects(),
        storage.getPhotos(),
        storage.getTasks(),
        storage.getChecklists(),
        storage.getShares(),
      ]);
      setProjects(p);
      setPhotos(ph);
      setTasks(ts);
      setChecklists(cl);
      setShares(sh);
      setReady(true);
    })();
  }, []);

  const persistProjects = useCallback(async (next: Project[]) => {
    setProjects(next);
    await storage.setProjects(next);
  }, []);
  const persistPhotos = useCallback(async (next: Photo[]) => {
    setPhotos(next);
    await storage.setPhotos(next);
  }, []);
  const persistTasks = useCallback(async (next: Task[]) => {
    setTasks(next);
    await storage.setTasks(next);
  }, []);
  const persistChecklists = useCallback(async (next: Checklist[]) => {
    setChecklists(next);
    await storage.setChecklists(next);
  }, []);
  const persistShares = useCallback(async (next: ShareLink[]) => {
    setShares(next);
    await storage.setShares(next);
  }, []);

  // --- Backend sync ---
  // Refs let our sync callbacks read current state without being recreated
  // every time the state changes (avoids effect re-runs / fetch loops).
  const projectsRef = useRef(projects);
  const tasksRef = useRef(tasks);
  const photosRef = useRef(photos);
  projectsRef.current = projects;
  tasksRef.current = tasks;
  photosRef.current = photos;

  // Throttle + dedupe refreshes triggered from many places (auth ready, app
  // foreground, screen focus, manual pull-to-refresh).
  const syncingRef = useRef(false);
  const lastSyncRef = useRef(0);

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
      await persistTasks(mergeById(tasksRef.current, mappedTasks));
      lastSyncRef.current = Date.now();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return false;
      setSyncError(e instanceof Error ? e.message : "Sync failed");
      return false;
    } finally {
      setSyncing(false);
    }
  }, [persistProjects, persistTasks]);

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
        const mappedMedia = (detail.media ?? []).map(mapBackendMedia);
        console.log("[photos] after mapping:", mappedMedia.length);
        const keptLocalPhotos = photosRef.current.filter(
          (p) => !(p.remote && p.projectId === idStr),
        );
        console.log("[photos] kept local:", keptLocalPhotos.length);
        console.log("[photos] total after persist:", (mappedMedia.length + keptLocalPhotos.length));
        await persistPhotos([...mappedMedia, ...keptLocalPhotos]);
        const mappedTasks = (detail.tasks ?? []).map(mapBackendTask);
        if (mappedTasks.length) {
          await persistTasks(mergeById(tasksRef.current, mappedTasks));
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return; // silently ignore
        if (!(e instanceof ApiError && e.status === 401)) {
          setSyncError(
            e instanceof Error ? e.message : "Failed to load project",
          );
        }
      }
    },
    [user, persistProjects, persistPhotos, persistTasks],
  );

  // --- Local CRUD (unchanged from before). Creates/updates stay local until
  //     we wire backend write endpoints.
  const createProject: DataState["createProject"] = useCallback(
    async (input) => {
      const now = new Date().toISOString();
      const p: Project = {
        id: newId(),
        name: input.name.trim(),
        address: input.address.trim(),
        client: input.client.trim(),
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      await persistProjects([p, ...projects]);
      return p;
    },
    [projects, persistProjects],
  );

  const updateProject: DataState["updateProject"] = useCallback(
    async (id, patch) => {
      const next = projects.map((p) =>
        p.id === id
          ? { ...p, ...patch, updatedAt: new Date().toISOString() }
          : p,
      );
      await persistProjects(next);
    },
    [projects, persistProjects],
  );

  const deleteProject: DataState["deleteProject"] = useCallback(
    async (id) => {
      await persistProjects(projects.filter((p) => p.id !== id));
      await persistPhotos(photos.filter((p) => p.projectId !== id));
      await persistTasks(tasks.filter((t) => t.projectId !== id));
      await persistChecklists(checklists.filter((c) => c.projectId !== id));
      await persistShares(shares.filter((s) => s.projectId !== id));
    },
    [
      projects,
      photos,
      tasks,
      checklists,
      shares,
      persistProjects,
      persistPhotos,
      persistTasks,
      persistChecklists,
      persistShares,
    ],
  );

  const addPhoto: DataState["addPhoto"] = useCallback(
    async (input) => {
      const { originalName, mimeType, fileSize, ...photoFields } = input;
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
      const next = [photo, ...photos];
      photosRef.current = next;
      await persistPhotos(next);
      return photo;
    },
    [photos, persistPhotos],
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
        const { originalName, mimeType, fileSize, ...photoFields } = i;
        void originalName;
        void mimeType;
        void fileSize;
        return {
          ...photoFields,
          id: newId(),
          uploaded: false,
          uploadQueueId: queueIds[idx],
        };
      });
      const next = [...created, ...photos];
      photosRef.current = next;
      await persistPhotos(next);
      return created;
    },
    [photos, persistPhotos],
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
        photosRef.current = next;
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

  const createTask: DataState["createTask"] = useCallback(
    async (projectId, title, notes, assignee) => {
      const task: Task = {
        id: newId(),
        projectId,
        title: title.trim(),
        notes: notes?.trim() || undefined,
        assignee: assignee?.trim() || undefined,
        done: false,
        createdAt: new Date().toISOString(),
      };
      await persistTasks([task, ...tasks]);
      return task;
    },
    [tasks, persistTasks],
  );

  const toggleTask: DataState["toggleTask"] = useCallback(
    async (id) => {
      await persistTasks(
        tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
      );
    },
    [tasks, persistTasks],
  );

  const deleteTask: DataState["deleteTask"] = useCallback(
    async (id) => {
      await persistTasks(tasks.filter((t) => t.id !== id));
    },
    [tasks, persistTasks],
  );

  const createChecklist: DataState["createChecklist"] = useCallback(
    async (projectId, title, items) => {
      const checklist: Checklist = {
        id: newId(),
        projectId,
        title: title.trim(),
        items: items
          .map((t) => t.trim())
          .filter(Boolean)
          .map<ChecklistItem>((text) => ({ id: newId(), text, done: false })),
        createdAt: new Date().toISOString(),
      };
      await persistChecklists([checklist, ...checklists]);
      return checklist;
    },
    [checklists, persistChecklists],
  );

  const toggleChecklistItem: DataState["toggleChecklistItem"] = useCallback(
    async (checklistId, itemId) => {
      await persistChecklists(
        checklists.map((c) =>
          c.id === checklistId
            ? {
                ...c,
                items: c.items.map((i) =>
                  i.id === itemId ? { ...i, done: !i.done } : i,
                ),
              }
            : c,
        ),
      );
    },
    [checklists, persistChecklists],
  );

  const deleteChecklist: DataState["deleteChecklist"] = useCallback(
    async (id) => {
      await persistChecklists(checklists.filter((c) => c.id !== id));
    },
    [checklists, persistChecklists],
  );

  const createShare: DataState["createShare"] = useCallback(
    async (projectId, recipientEmail) => {
      const s: ShareLink = {
        id: newId(),
        projectId,
        recipientEmail: recipientEmail.trim().toLowerCase(),
        url: `https://fieldview.app/share/${newId()}`,
        createdAt: new Date().toISOString(),
      };
      await persistShares([s, ...shares]);
      return s;
    },
    [shares, persistShares],
  );

  const revokeShare: DataState["revokeShare"] = useCallback(
    async (id) => {
      await persistShares(shares.filter((s) => s.id !== id));
    },
    [shares, persistShares],
  );

  const clearAll: DataState["clearAll"] = useCallback(async () => {
    // Wipe in-memory + persisted local data. Used by account-deletion and
    // leave-team flows to ensure a deleted user's data doesn't linger and
    // that the next sign-in starts from a clean slate. Ordinary sign-out
    // does NOT call this — it preserves the offline-first cache.
    await Promise.all([
      persistProjects([]),
      persistPhotos([]),
      persistTasks([]),
      persistChecklists([]),
      persistShares([]),
      clearUploadQueueAll().catch(() => {}),
    ]);
    setSyncError(null);
    lastSyncRef.current = 0;
  }, [persistProjects, persistPhotos, persistTasks, persistChecklists, persistShares]);

  const value = useMemo<DataState>(
    () => ({
      projects,
      photos,
      tasks,
      checklists,
      shares,
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
      createTask,
      toggleTask,
      deleteTask,
      createChecklist,
      toggleChecklistItem,
      deleteChecklist,
      createShare,
      revokeShare,
      clearAll,
    }),
    [
      projects,
      photos,
      tasks,
      checklists,
      shares,
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
      createTask,
      toggleTask,
      deleteTask,
      createChecklist,
      toggleChecklistItem,
      deleteChecklist,
      createShare,
      revokeShare,
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
