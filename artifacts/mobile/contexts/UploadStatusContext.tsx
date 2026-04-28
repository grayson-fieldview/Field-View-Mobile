import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
const TOAST_AUTO_DISMISS_MS = 4_000;

export function UploadStatusProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [queue, setQueue] = useState<QueuedUpload[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

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
          setToastMessage(TOAST_FAILURE_MESSAGE);
        }
      }
      seenFirstUpdateRef.current = true;
      prevFailedIdsRef.current = currentFailedIds;
    });
    return unsub;
  }, []);

  // Auto-dismiss the toast after a few seconds.
  useEffect(() => {
    if (!toastMessage) return;
    const t = setTimeout(() => setToastMessage(null), TOAST_AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [toastMessage]);

  const byId = useMemo(() => {
    const m = new Map<string, QueuedUpload>();
    for (const it of queue) m.set(it.id, it);
    return m;
  }, [queue]);

  const value = useMemo<UploadStatusContextValue>(() => ({ byId }), [byId]);

  return (
    <UploadStatusContext.Provider value={value}>
      {children}
      {toastMessage ? (
        <ToastBanner
          message={toastMessage}
          onDismiss={() => setToastMessage(null)}
        />
      ) : null}
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

function ToastBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      style={[styles.toastWrap, { top: insets.top + 12 }]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${message} Tap to dismiss.`}
        onPress={onDismiss}
        style={styles.toast}
      >
        <Text style={styles.toastText}>{message}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  toastWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    paddingHorizontal: 16,
  },
  toast: {
    backgroundColor: "rgba(28,28,30,0.95)",
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    maxWidth: 480,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  toastText: {
    color: "#fff",
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    textAlign: "center",
  },
});
