import type {
  BackendMedia,
  BackendProject,
  BackendTask,
} from "./api";
import type { Photo, Project, Task } from "./types";

const DONE_TASK_STATUSES = new Set(["done", "completed", "complete"]);

export function mapBackendProject(b: BackendProject): Project {
  return {
    id: String(b.id),
    name: b.name ?? "",
    address: b.address ?? "",
    // Web backend uses `description` for the project description and `name`
    // for the primary label. We surface description as the "client" subtitle
    // on cards until we have a dedicated field.
    client: b.description ?? "",
    description: b.description ?? undefined,
    status: (b.status ?? "active").toString(),
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    photoCount: typeof b.photoCount === "number" ? b.photoCount : undefined,
    color: b.color ?? undefined,
    tags: b.tags ?? undefined,
    latitude: b.latitude ?? undefined,
    longitude: b.longitude ?? undefined,
    coverPhotoUrl: b.recentPhotos?.[0]?.url,
    remote: true,
  };
}

export function mapBackendMedia(m: BackendMedia): Photo {
  return {
    id: String(m.id),
    projectId: String(m.projectId),
    uri: m.url,
    remoteUrl: m.url,
    takenAt: m.createdAt,
    latitude: m.latitude ?? undefined,
    longitude: m.longitude ?? undefined,
    note: m.caption ?? undefined,
    tags: m.tags ?? undefined,
    uploaded: true,
    remote: true,
  };
}

export function mapBackendTask(t: BackendTask): Task {
  return {
    id: String(t.id),
    projectId: String(t.projectId),
    title: t.title ?? "",
    notes: t.description ?? undefined,
    done: DONE_TASK_STATUSES.has((t.status ?? "").toString().toLowerCase()),
    createdAt: t.createdAt,
    remote: true,
  };
}
