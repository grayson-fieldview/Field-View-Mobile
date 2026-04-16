export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  address: string;
  client: string;
  /** "active" | "on-hold" | "complete" — but backend may return other strings, so we keep it loose. */
  status: string;
  createdAt: string;
  updatedAt: string;
  /** Optional fields surfaced from the web backend. */
  description?: string;
  photoCount?: number;
  color?: string;
  tags?: string[];
  latitude?: number;
  longitude?: number;
  coverPhotoUrl?: string;
  /** True when this record originated from the backend (not a local draft). */
  remote?: boolean;
}

export interface Photo {
  id: string;
  projectId: string;
  uri: string;
  remoteUrl?: string;
  takenAt: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  note?: string;
  uploaded: boolean;
  tags?: string[];
  remote?: boolean;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  notes?: string;
  done: boolean;
  dueDate?: string;
  createdAt: string;
  remote?: boolean;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface Checklist {
  id: string;
  projectId: string;
  title: string;
  items: ChecklistItem[];
  createdAt: string;
}

export interface ShareLink {
  id: string;
  projectId: string;
  recipientEmail: string;
  url: string;
  createdAt: string;
}

export type Id = string;
