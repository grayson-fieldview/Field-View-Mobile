import { useCallback, useEffect, useState } from "react";

import { ApiError, api, type BackendProjectFile } from "@/services/api";

/**
 * Project-scoped files list (read-only).
 *
 * Same shape as useProjectReports minus the mutations: owns its own
 * loading + error state and re-fetches whenever the project id changes.
 * Upload is web-only for now, so there are no optimistic ops here.
 */
export interface ProjectFilesState {
  files: BackendProjectFile[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useProjectFiles(
  projectId: string | undefined,
): ProjectFilesState {
  const [files, setFiles] = useState<BackendProjectFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const list = await api.listFilesForProject(projectId);
      setFiles(Array.isArray(list) ? list : []);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof Error ? e.message : "Couldn't load files.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { files, loading, error, refresh };
}
