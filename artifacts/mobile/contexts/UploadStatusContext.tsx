import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useToast } from "@/contexts/ToastContext";
import {
  type QueuedUpload,
  subscribe as subscribeUploadQueue,
} from "@/services/uploadQueue";

interface UploadStatusContextValue {
  byId: Map<string, QueuedUpload>;
}

const UploadStatusContext = createContext<UploadStatusContextValue | undefined>(
  undefined,
);

const TOAST_FAILURE_MESSAGE =
  "Some photos failed to upload — they'll retry automatically.";

export function UploadStatusProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [queue, setQueue] = useState<QueuedUpload[]>([]);
  const { showToast } = useToast();

  // Toast trigger bookkeeping. We only want to fire the toast on the FIRST
  // failure that happens during this session — not for items that were
  // already in "failed" state when the session started (e.g. carried over
  // from a previous session via AsyncStorage).
  const prevFailedIdsRef = useRef<Set<string>>(new Set());
  const hasShownFailureToastRef = useRef(false);
  const seenFirstUpdateRef = useRef(false);

  useEffect(() => {
    const unsub = subscribeUploadQueue((q) => {
      setQueue(q);
      const currentFailedIds = new Set(
        q.filter((it) => it.status === "failed").map((it) => it.id),
      );
      if (seenFirstUpdateRef.current && !hasShownFailureToastRef.current) {
        let newlyFailed = false;
        for (const id of currentFailedIds) {
          if (!prevFailedIdsRef.current.has(id)) {
            newlyFailed = true;
            break;
          }
        }
        if (newlyFailed) {
          hasShownFailureToastRef.current = true;
          showToast(TOAST_FAILURE_MESSAGE);
        }
      }
      seenFirstUpdateRef.current = true;
      prevFailedIdsRef.current = currentFailedIds;
    });
    return unsub;
  }, [showToast]);

  const byId = useMemo(() => {
    const m = new Map<string, QueuedUpload>();
    for (const it of queue) m.set(it.id, it);
    return m;
  }, [queue]);

  const value = useMemo<UploadStatusContextValue>(() => ({ byId }), [byId]);

  return (
    <UploadStatusContext.Provider value={value}>
      {children}
    </UploadStatusContext.Provider>
  );
}

/**
 * Returns the current queue item for a given local upload-queue id, or null
 * if there's no live queue item (uploaded items get removed by the
 * DataContext reconciler shortly after success).
 */
export function useUploadStatus(uploadQueueId?: string): QueuedUpload | null {
  const ctx = useContext(UploadStatusContext);
  if (!ctx || !uploadQueueId) return null;
  return ctx.byId.get(uploadQueueId) ?? null;
}
