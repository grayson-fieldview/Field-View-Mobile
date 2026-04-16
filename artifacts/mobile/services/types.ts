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
  status: "active" | "on-hold" | "complete";
  createdAt: string;
  updatedAt: string;
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
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  notes?: string;
  done: boolean;
  dueDate?: string;
  createdAt: string;
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
