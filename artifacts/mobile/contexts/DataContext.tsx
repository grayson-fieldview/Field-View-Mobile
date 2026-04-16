import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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

interface DataState {
  projects: Project[];
  photos: Photo[];
  tasks: Task[];
  checklists: Checklist[];
  shares: ShareLink[];
  ready: boolean;
  syncing: boolean;
  syncError: string | null;

  /** Force a re-sync of projects + tasks from the backend. */
  refresh: () => Promise<void>;

  /** Load a single project's detail (photos + tasks + checklists) into state. */
  loadProjectDetail: (id: string) => Promise<void>;

  createProject: (
    input: Pick<Project, "name" | "address" | "client">,
  ) => Promise<Project>;
  updateProject: (id: string, patch: Partial<Project>) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;

  addPhoto: (input: Omit<Photo, "id" | "uploaded">) => Promise<Photo>;
  addPhotosBatch: (
    inputs: Array<Omit<Photo, "id" | "uploaded">>,
  ) => Promise<Photo[]>;
  deletePhoto: (id: string) => Promise<void>;

  createTask: (
    projectId: string,
    title: string,
    notes?: string,
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

  const refresh = useCallback(async () => {
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
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // Auth context will handle logout; don't surface as error here.
        return;
      }
      setSyncError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }, [persistProjects, persistTasks]);

  // Re-sync whenever the authenticated user changes.
  useEffect(() => {
    if (!authReady || !ready) return;
    if (!user) {
      // Logged out — we leave cached local state alone; it's behind auth gate.
      setSyncError(null);
      return;
    }
    refresh();
    // We want this to run on user id change only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, ready, user?.id]);

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
        await persistProjects(
          mergeById(projectsRef.current, [mappedProject]),
        );
        // Always replace remote photos for this project (even with empty list,
        // so stale deletions on the web propagate); keep local-only rows.
        const mappedMedia = (detail.media ?? []).map(mapBackendMedia);
        const keptLocalPhotos = photosRef.current.filter(
          (p) => !(p.remote && p.projectId === idStr),
        );
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
      const photo: Photo = { ...input, id: newId(), uploaded: false };
      await persistPhotos([photo, ...photos]);
      return photo;
    },
    [photos, persistPhotos],
  );

  const addPhotosBatch: DataState["addPhotosBatch"] = useCallback(
    async (inputs) => {
      const created: Photo[] = inputs.map((i) => ({
        ...i,
        id: newId(),
        uploaded: false,
      }));
      await persistPhotos([...created, ...photos]);
      return created;
    },
    [photos, persistPhotos],
  );

  const deletePhoto: DataState["deletePhoto"] = useCallback(
    async (id) => {
      await persistPhotos(photos.filter((p) => p.id !== id));
    },
    [photos, persistPhotos],
  );

  const createTask: DataState["createTask"] = useCallback(
    async (projectId, title, notes) => {
      const task: Task = {
        id: newId(),
        projectId,
        title: title.trim(),
        notes: notes?.trim() || undefined,
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
      createTask,
      toggleTask,
      deleteTask,
      createChecklist,
      toggleChecklistItem,
      deleteChecklist,
      createShare,
      revokeShare,
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
      createTask,
      toggleTask,
      deleteTask,
      createChecklist,
      toggleChecklistItem,
      deleteChecklist,
      createShare,
      revokeShare,
    ],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataState {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error("useData must be used inside DataProvider");
  return ctx;
}
