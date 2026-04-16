import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { newId } from "@/services/id";
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

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [ready, setReady] = useState(false);

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
        p.id === id ? { ...p, ...patch, updatedAt: new Date().toISOString() } : p,
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
