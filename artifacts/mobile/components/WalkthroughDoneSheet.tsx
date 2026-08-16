import NetInfo from "@react-native-community/netinfo";
import { Feather } from "@expo/vector-icons";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { Button } from "@/components/Button";
import { useData } from "@/contexts/DataContext";
import { useColors } from "@/hooks/useColors";
import { api } from "@/services/api";
import {
  getQueue,
  retryItem,
  subscribe as subscribeToQueue,
  type QueuedUpload,
} from "@/services/uploadQueue";

/**
 * Walkthrough Done pipeline, presented as a Modal over the camera.
 * The recording has ALREADY been stopped by the caller — this sheet
 * receives the audio file and the session photo entries and runs:
 *
 *   connection check → block on uploads (visible progress + cancel)
 *   → transcribe → POST /walkthrough → "report is generating" screen
 *
 * Failure philosophy (spec §5.7): by the time anything here can fail,
 * the photos are on the project through the untouched upload queue —
 * every failure message says so plainly. Cancel during upload abandons
 * REPORT GENERATION only; uploads keep running in the queue.
 *
 * Media-id resolution uses the EXISTING correlation mechanism, not a
 * new one: each local Photo stores its `uploadQueueId`; the queue item
 * gains `uploadedMediaId` when createMedia succeeds; DataContext's
 * reconciliation then copies it onto the Photo as `mediaId` and prunes
 * the queue item. We accept the server id from whichever of the two
 * surfaces has it (photo.mediaId, or the still-live queue item's
 * uploadedMediaId) — same data, two moments in its lifecycle.
 */

export interface WalkthroughSessionPhoto {
  /** Local Photo.id (DataContext-generated). */
  localId: string;
  /** Photo.uploadQueueId — key into the upload queue. */
  uploadQueueId?: string;
  /** Date.now()-basis ms offset from recording start. */
  offsetMs: number;
}

interface Props {
  visible: boolean;
  projectId: string;
  /** Stopped recording; null only if stopping failed upstream. */
  audio: { uri: string; mimeType: string } | null;
  sessionPhotos: WalkthroughSessionPhoto[];
  /** Close the sheet and return to the camera (photos always kept). */
  onDismiss: () => void;
  /** Close the sheet and leave the capture screen. */
  onExit: () => void;
}

type Phase =
  | "checking" // NetInfo connection check
  | "offline" // terminal: exit without generating
  | "uploading" // blocking on the session's queue items
  | "transcribing"
  | "generating" // POST /walkthrough in flight
  | "done" // 202 accepted — report building
  | "error"; // terminal failure; photos are saved

/** Resolve a session photo to its server media id, if known yet. */
function resolveMediaId(
  entry: WalkthroughSessionPhoto,
  photoMediaIds: Map<string, number>,
  queueSnapshot: QueuedUpload[],
): number | undefined {
  const fromPhoto = photoMediaIds.get(entry.localId);
  if (typeof fromPhoto === "number") return fromPhoto;
  if (entry.uploadQueueId) {
    const item = queueSnapshot.find((q) => q.id === entry.uploadQueueId);
    if (item && typeof item.uploadedMediaId === "number") {
      return item.uploadedMediaId;
    }
  }
  return undefined;
}

export function WalkthroughDoneSheet({
  visible,
  projectId,
  audio,
  sessionPhotos,
  onDismiss,
  onExit,
}: Props) {
  const colors = useColors();
  const { photos } = useData();
  const [phase, setPhase] = useState<Phase>("checking");
  const [uploadedCount, setUploadedCount] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Bumped on cancel/close so an in-flight async continuation from a
  // previous run can't mutate state for the next one.
  const genRef = useRef(0);
  const mountedRef = useRef(true);
  // Live queue snapshot — getQueue() is async, so we keep the latest
  // snapshot in state (seeded on open, refreshed by the subscriber,
  // which is called WITH the new queue).
  const [queueSnapshot, setQueueSnapshot] = useState<QueuedUpload[]>([]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      genRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    void getQueue().then((q) => {
      if (alive && mountedRef.current) setQueueSnapshot(q);
    });
    const unsub = subscribeToQueue((q) => {
      if (mountedRef.current) setQueueSnapshot([...q]);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [visible]);

  // Latest photo.mediaId map (reconciliation writes it there after
  // pruning the queue item).
  const photoMediaIds = new Map<string, number>();
  for (const p of photos) {
    if (typeof p.mediaId === "number") photoMediaIds.set(p.id, p.mediaId);
  }

  // ---- Phase 1: connection check on open --------------------------------
  useEffect(() => {
    if (!visible) return;
    genRef.current += 1;
    const gen = genRef.current;
    setPhase("checking");
    setErrorMsg(null);
    void NetInfo.fetch().then((state) => {
      if (!mountedRef.current || genRef.current !== gen) return;
      const online =
        state.isConnected === true && state.isInternetReachable !== false;
      if (!online) {
        setPhase("offline");
        return;
      }
      // Nudge any session items sitting in backoff so the blocking
      // wait doesn't idle through a retry delay. retryItem is the
      // queue's own public reset — no retry/ordering logic changed.
      void getQueue().then((q) => {
        if (!mountedRef.current || genRef.current !== gen) return;
        for (const entry of sessionPhotos) {
          if (!entry.uploadQueueId) continue;
          const item = q.find((it) => it.id === entry.uploadQueueId);
          if (item && item.status === "failed") void retryItem(item.id);
        }
        setPhase("uploading");
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // ---- Phase 2: block on uploads ----------------------------------------
  useEffect(() => {
    if (!visible || phase !== "uploading") return;
    const gen = genRef.current;

    let resolvedCount = 0;
    let unrecoverable = 0;
    for (const entry of sessionPhotos) {
      const id = resolveMediaId(entry, photoMediaIds, queueSnapshot);
      if (typeof id === "number") {
        resolvedCount += 1;
        continue;
      }
      if (entry.uploadQueueId) {
        const item = queueSnapshot.find((q) => q.id === entry.uploadQueueId);
        if (item?.status === "unrecoverable") unrecoverable += 1;
        if (!item && !photoMediaIds.has(entry.localId)) {
          // Queue item gone but no mediaId surfaced — count as failed
          // rather than waiting forever.
          unrecoverable += 1;
        }
      } else {
        unrecoverable += 1;
      }
    }
    setUploadedCount(resolvedCount);

    if (unrecoverable > 0) {
      setPhase("error");
      setErrorMsg(
        `${unrecoverable} photo${unrecoverable === 1 ? "" : "s"} couldn't upload, so the report wasn't generated. All captured photos stay saved on the project and keep retrying in the background.`,
      );
      return;
    }

    if (resolvedCount === sessionPhotos.length) {
      // All uploaded (or there were zero photos) → transcribe.
      const run = async () => {
        setPhase("transcribing");
        let transcript: string;
        try {
          if (!audio) throw new Error("No walkthrough audio was captured.");
          const res = await api.transcribeAudio(audio.uri, audio.mimeType);
          transcript = res.transcript;
        } catch (e) {
          if (!mountedRef.current || genRef.current !== gen) return;
          setPhase("error");
          setErrorMsg(
            `${e instanceof Error && e.message ? e.message : "Couldn't transcribe the narration."} Your photos are saved on the project.`,
          );
          return;
        }
        if (!mountedRef.current || genRef.current !== gen) return;
        setPhase("generating");
        try {
          const mediaIds: number[] = [];
          const photoOffsets: Array<{ mediaId: number; offsetMs: number }> =
            [];
          for (const entry of sessionPhotos) {
            const id = resolveMediaId(entry, photoMediaIds, queueSnapshot);
            if (typeof id !== "number") continue; // resolved above; belt & braces
            mediaIds.push(id);
            photoOffsets.push({ mediaId: id, offsetMs: entry.offsetMs });
          }
          await api.generateWalkthrough(projectId, {
            transcript,
            mediaIds,
            photoOffsets: photoOffsets.length > 0 ? photoOffsets : undefined,
          });
          if (!mountedRef.current || genRef.current !== gen) return;
          setPhase("done");
        } catch (e) {
          if (!mountedRef.current || genRef.current !== gen) return;
          setPhase("error");
          setErrorMsg(
            `${e instanceof Error && e.message ? e.message : "Couldn't start the report."} Your photos are saved on the project.`,
          );
        }
      };
      void run();
    }
    // queueSnapshot + photos drive re-evaluation while waiting on
    // uploads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, phase, queueSnapshot, photos]);

  const cancelAndKeepPhotos = () => {
    // Abandon report generation; uploads continue in the queue.
    genRef.current += 1;
    onDismiss();
  };

  const total = sessionPhotos.length;

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={styles.backdrop}>
        <View
          style={[
            styles.card,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          {phase === "checking" ? (
            <>
              <ActivityIndicator color={colors.primary} />
              <Text style={[styles.title, { color: colors.foreground }]}>
                Finishing walkthrough…
              </Text>
            </>
          ) : phase === "offline" ? (
            <>
              <Feather name="wifi-off" size={28} color={colors.mutedForeground} />
              <Text style={[styles.title, { color: colors.foreground }]}>
                Walkthrough needs a connection.
              </Text>
              <Text style={[styles.body, { color: colors.mutedForeground }]}>
                Your photos are saved and will upload when you're back
                online.
              </Text>
              <Button title="OK" onPress={onExit} />
            </>
          ) : phase === "uploading" ? (
            <>
              <ActivityIndicator color={colors.primary} />
              <Text style={[styles.title, { color: colors.foreground }]}>
                Uploading {Math.min(uploadedCount + 1, total)} of {total}
              </Text>
              <Text style={[styles.body, { color: colors.mutedForeground }]}>
                Hang tight — the report needs every photo on the server
                first.
              </Text>
              <Button
                title="Cancel"
                variant="secondary"
                onPress={cancelAndKeepPhotos}
              />
              <Text style={[styles.fine, { color: colors.mutedForeground }]}>
                Canceling skips the report. Photos keep uploading.
              </Text>
            </>
          ) : phase === "transcribing" || phase === "generating" ? (
            <>
              <ActivityIndicator color={colors.primary} />
              <Text style={[styles.title, { color: colors.foreground }]}>
                {phase === "transcribing"
                  ? "Transcribing your narration…"
                  : "Starting your report…"}
              </Text>
            </>
          ) : phase === "done" ? (
            <>
              <Feather name="check-circle" size={28} color={colors.primary} />
              <Text style={[styles.title, { color: colors.foreground }]}>
                AI is building your report.
              </Text>
              <Text style={[styles.body, { color: colors.mutedForeground }]}>
                We'll notify you when it's ready.
              </Text>
              <Button title="Done" onPress={onExit} />
            </>
          ) : (
            <>
              <Feather name="alert-circle" size={28} color={colors.destructive} />
              <Text style={[styles.title, { color: colors.foreground }]}>
                Couldn't generate the report
              </Text>
              <Text style={[styles.body, { color: colors.mutedForeground }]}>
                {errorMsg ?? "Something went wrong. Your photos are saved on the project."}
              </Text>
              <Button title="OK" variant="secondary" onPress={onExit} />
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 24,
    alignItems: "center",
    gap: 14,
  },
  title: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
    textAlign: "center",
  },
  body: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
  fine: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    textAlign: "center",
  },
});
