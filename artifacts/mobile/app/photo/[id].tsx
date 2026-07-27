import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as MediaLibrary from "expo-media-library";
import { VideoView, useVideoPlayer } from "expo-video";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Gallery from "react-native-awesome-gallery";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  AnnotationEditor,
  AnnotationLayer,
  COLORS,
  SIZES,
} from "@/components/AnnotationEditor";
import { fittedContainRect } from "@/services/annotations";
import { useData } from "@/contexts/DataContext";
import { useToast } from "@/contexts/ToastContext";
import { ApiError, api, buildMediaReferencesMessage } from "@/services/api";
import type { BackendCommentResponse } from "@/services/api";
import type { Photo, StoredStroke } from "@/services/types";

/**
 * Full-screen video player for the viewer. Used both inside the gallery
 * (read mode) and in place of the annotate canvas when the open media is a
 * video (videos can't be drawn on). Uses expo-video's useVideoPlayer —
 * which is why this lives in its own component: the gallery's renderItem
 * can't call hooks per-item, so each video item mounts one of these.
 */
function VideoGalleryItem({
  uri,
  onReady,
}: {
  uri: string;
  /**
   * Optional. react-native-awesome-gallery needs a non-zero item size or
   * its pinch/zoom math divides by zero. Images report it via expo-image's
   * onLoad; video has no equivalent, so the gallery branch passes this to
   * seed a size once after mount.
   */
  onReady?: () => void;
}) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
  });
  useEffect(() => {
    onReady?.();
  }, [onReady]);
  return (
    <View style={StyleSheet.absoluteFill}>
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        nativeControls
        allowsFullscreen
      />
    </View>
  );
}

export default function PhotoViewerScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { photos, updatePhoto, deletePhoto, loadPhotoAnnotations, saveAnnotations } =
    useData();
  const { showToast } = useToast();
  // True while we're fetching references for the trash button — drives
  // the inline spinner replacement of the trash icon. The actual
  // Alert.alert isn't a "loading" surface, so the spinner only shows
  // during the GET /api/media/:id/references round-trip.
  const [trashLoading, setTrashLoading] = useState(false);

  const startPhoto = useMemo(() => photos.find((p) => p.id === id), [photos, id]);
  const projectPhotos = useMemo(
    () =>
      startPhoto
        ? photos.filter((p) => p.projectId === startPhoto.projectId)
        : [],
    [photos, startPhoto],
  );
  const startIndex = useMemo(() => {
    const i = projectPhotos.findIndex((p) => p.id === id);
    return i < 0 ? 0 : i;
  }, [projectPhotos, id]);

  // currentIndex is the single source of truth for "which photo am I on?"
  // across both render branches. Gallery's onIndexChange writes it; the
  // edit branch reads it to render the active photo. When the user
  // toggles edit mode, the gallery unmounts and remounts with
  // initialIndex={currentIndex}, so position is preserved automatically.
  const [currentIndex, setCurrentIndex] = useState(startIndex);
  // Re-seat currentIndex if the photo set changes underneath us (e.g.
  // a sibling delete shifts indices). Clamp to the new bounds.
  useEffect(() => {
    if (projectPhotos.length === 0) return;
    if (currentIndex >= projectPhotos.length) {
      setCurrentIndex(projectPhotos.length - 1);
    }
  }, [projectPhotos.length, currentIndex]);
  const currentPhoto = projectPhotos[currentIndex];

  const [editing, setEditing] = useState(false);
  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState(SIZES[1]);
  // Per-photo EDITABLE buffer — the current user's OWN strokes, in canonical
  // (0..1) form, keyed by photo id. Seeded from the server on photo open via
  // loadPhotoAnnotations (server is source of truth). undo/clear/draw all
  // operate on this buffer; it is the payload saved back to the server.
  const [strokesById, setStrokesById] = useState<
    Record<string, StoredStroke[]>
  >({});
  // Other users' strokes, kept separate so the editor can render the full
  // union (others + own-live-buffer) without double-drawing or letting the
  // user edit collaborators' strokes.
  const [othersById, setOthersById] = useState<Record<string, StoredStroke[]>>(
    {},
  );

  // Read-mode (gallery) box. Items are absoluteFill, so a single captured
  // size applies to every sibling. NOT the coordinate basis — that's the
  // per-photo fitted image rect (readBox + intrinsic dims), matching the
  // web editor's basis.
  const [readBox, setReadBox] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });
  // Per-photo intrinsic pixel size from expo-image's onLoad, needed to
  // compute each photo's fitted rect. Until a photo's size is known its
  // annotations render NOWHERE — never against the container basis.
  const [imgDimsById, setImgDimsById] = useState<
    Record<string, { w: number; h: number }>
  >({});

  // Photos with unsaved buffer changes since the last server flush. We flush
  // on edit-mode exit (and unmount) rather than per-stroke to avoid spamming
  // the server with a request for every finger lift.
  const dirtyRef = useRef<Set<string>>(new Set());

  // Server is source of truth on open: fetch the photo's annotation rows and
  // seed the editable buffer (own) + others split for the current photo.
  const currentPhotoId = currentPhoto?.id;
  useEffect(() => {
    if (!currentPhotoId) return;
    let cancelled = false;
    void (async () => {
      const { ownStrokes, othersStrokes } =
        await loadPhotoAnnotations(currentPhotoId);
      if (cancelled) return;
      // TEMP DIAG (Bug 2, build 39): strokes received by the screen.
      console.log(
        `[annot-diag] photo ${currentPhotoId}: own=${ownStrokes.length}, others=${othersStrokes.length}, dirty=${dirtyRef.current.has(currentPhotoId)}`,
      );
      // Never let a late server response clobber unsaved local edits: if the
      // user started drawing before this fetch resolved, the photo is dirty
      // and the local buffer wins (last-write-wins for the own row). Others'
      // strokes always update — they're not user-editable here.
      if (!dirtyRef.current.has(currentPhotoId)) {
        setStrokesById((prev) => ({ ...prev, [currentPhotoId]: ownStrokes }));
      }
      setOthersById((prev) => ({ ...prev, [currentPhotoId]: othersStrokes }));
    })();
    return () => {
      cancelled = true;
    };
  }, [currentPhotoId, loadPhotoAnnotations]);

  // Flush the own-row buffer to the server when the user leaves edit mode.
  const prevEditingRef = useRef(editing);
  useEffect(() => {
    const was = prevEditingRef.current;
    prevEditingRef.current = editing;
    if (was && !editing && currentPhotoId && dirtyRef.current.has(currentPhotoId)) {
      const pid = currentPhotoId;
      void (async () => {
        // Clear dirty ONLY after the server accepts the write. On failure the
        // flag stays set so the unmount flush (or next exit) retries — the
        // edit is never silently dropped.
        const ok = await saveAnnotations(pid, strokesById[pid] ?? []);
        if (ok) {
          dirtyRef.current.delete(pid);
          // Clobber-guard merge: the server row now holds MORE than the
          // buffer (recovered strokes). Adopt the merged set so a later
          // re-edit of this photo can't re-drop them.
          if (Array.isArray(ok)) {
            setStrokesById((prev) => ({ ...prev, [pid]: ok }));
          }
        } else {
          // A failed server flush was previously 100% silent — the user
          // walked away believing their markup synced (build 40 Bug A).
          // The edit is safe locally and retries on next exit/unmount,
          // but say so.
          showToast("Markup saved on this phone — couldn't sync yet");
        }
      })();
    }
  }, [editing, currentPhotoId, saveAnnotations, strokesById]);

  // Safety net: flush any still-dirty buffers when the screen unmounts. A ref
  // holds the latest closure so the unmount-only effect sees current state.
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    for (const pid of [...dirtyRef.current]) {
      void (async () => {
        // Clear dirty per-photo only on success; a failed write leaves the
        // flag set (best-effort on unmount — there's no further retry hook,
        // but the local buffer is already persisted so nothing is lost).
        const ok = await saveAnnotations(pid, strokesById[pid] ?? []);
        if (ok) dirtyRef.current.delete(pid);
        // No setStrokesById here — the screen is unmounting; the merged
        // union was already persisted to Photo.annotations by the save.
      })();
    }
  };
  useEffect(() => () => flushRef.current(), []);

  // ----- Photo comments (display + create; no delete endpoint exists) -----
  // Keyed off the CURRENT photo's backend mediaId. Local-only photos
  // (pending/failed uploads, mediaId undefined) get no comments UI at all.
  const currentMediaId = currentPhoto?.mediaId;
  const [comments, setComments] = useState<BackendCommentResponse[] | null>(
    null, // null = loading (or not yet requested)
  );
  const [commentsError, setCommentsError] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [postingComment, setPostingComment] = useState(false);
  // Monotonic sequence guards against a slow response for photo A landing
  // after the user swiped to photo B (no stale comments from the previous
  // photo). Any newer request or photo change bumps the sequence and the
  // stale response is dropped.
  const commentsFetchSeq = useRef(0);
  // Ref mirror so async handlers can check "am I still on this photo?"
  // after an await without capturing a stale render value.
  const currentMediaIdRef = useRef(currentMediaId);
  currentMediaIdRef.current = currentMediaId;

  const loadComments = useCallback(async (mid: number) => {
    const seq = ++commentsFetchSeq.current;
    try {
      const rows = await api.getMediaComments(mid);
      if (commentsFetchSeq.current !== seq) return;
      setComments(rows);
      setCommentsError(false);
    } catch {
      if (commentsFetchSeq.current !== seq) return;
      setComments([]);
      setCommentsError(true);
    }
  }, []);

  useEffect(() => {
    // Swiped to a different photo: drop everything from the previous one
    // (list, draft, in-flight markers) and fetch fresh.
    commentsFetchSeq.current++;
    setComments(null);
    setCommentsError(false);
    setCommentDraft("");
    setPostingComment(false);
    if (currentMediaId !== undefined) void loadComments(currentMediaId);
  }, [currentMediaId, loadComments]);

  const onPostComment = async () => {
    if (currentMediaId === undefined) return;
    const content = commentDraft.trim();
    if (!content || postingComment) return;
    const mid = currentMediaId;
    setPostingComment(true);
    try {
      await api.createMediaComment(mid, content);
    } catch (e) {
      setPostingComment(false);
      if (e instanceof ApiError && e.status === 401) return;
      // Keep the typed text so the user can retry.
      showToast("Couldn't post comment");
      return;
    }
    setPostingComment(false);
    // Server contract: POST returns the bare row without the joined user
    // object, so re-fetch the list instead of appending locally. Only
    // clear the draft (and refetch) if we're still on the same photo —
    // if the user swiped away mid-post the effect already reset state.
    if (currentMediaIdRef.current === mid) {
      setCommentDraft("");
      void loadComments(mid);
    }
  };

  if (!startPhoto || !currentPhoto) {
    return (
      <View style={styles.bg}>
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={{ color: "#fff", textAlign: "center", marginTop: 100 }}>
          Photo not found.
        </Text>
      </View>
    );
  }

  // Persist a buffer change locally (offline buffer + optimistic render set)
  // and mark the photo dirty for the next server flush. The local render set
  // (Photo.annotations) is the union of others + own so thumbnails / read
  // mode stay correct without waiting for the server round-trip.
  const persistLocalUnion = async (pid: string, ownNext: StoredStroke[]) => {
    dirtyRef.current.add(pid);
    const others = othersById[pid] ?? [];
    await updatePhoto(pid, { annotations: [...others, ...ownNext] });
  };

  // AnnotationEditor hands each finished stroke up already in canonical
  // 0..1 form (type from its active tool); append + persist locally.
  const commitStroke = async (canonical: StoredStroke) => {
    const pid = currentPhoto.id;
    const next = [...(strokesById[pid] ?? []), canonical];
    setStrokesById((prev) => ({ ...prev, [pid]: next }));
    await persistLocalUnion(pid, next);
  };

  // Replace one OWN stroke (matched by id) after a select-tool move. Same
  // dirty/flush pipeline as commitStroke — the exit flush PUTs the row.
  const replaceStroke = async (updated: StoredStroke) => {
    const pid = currentPhoto.id;
    const next = (strokesById[pid] ?? []).map((s) =>
      s.id === updated.id ? updated : s,
    );
    setStrokesById((prev) => ({ ...prev, [pid]: next }));
    await persistLocalUnion(pid, next);
  };

  // Delete one OWN stroke by id: own row minus that stroke, via the same
  // save path (no new API surface).
  const deleteStroke = async (id: string) => {
    const pid = currentPhoto.id;
    const next = (strokesById[pid] ?? []).filter((s) => s.id !== id);
    setStrokesById((prev) => ({ ...prev, [pid]: next }));
    await persistLocalUnion(pid, next);
  };

  const undo = async () => {
    const pid = currentPhoto.id;
    const list = strokesById[pid] ?? [];
    if (list.length === 0) return;
    const next = list.slice(0, -1);
    setStrokesById((prev) => ({ ...prev, [pid]: next }));
    await persistLocalUnion(pid, next);
  };

  const clearAll = async () => {
    const pid = currentPhoto.id;
    setStrokesById((prev) => ({ ...prev, [pid]: [] }));
    await persistLocalUnion(pid, []);
  };

  const onDelete = async () => {
    const photo = currentPhoto;
    const photoId = photo.id;
    const mediaId = photo.mediaId;

    // Server-first then local. Sequence is deliberate:
    //  1. Resolve mediaId — if the photo never uploaded (failed/pending),
    //     skip the server entirely and just do local cleanup.
    //  2. Fetch references and build the warning copy. Show spinner on
    //     the trash button only during this fetch.
    //  3. Confirm dialog (refs-aware copy).
    //  4. On confirm: DELETE /api/media/:id, THEN router.back() + local
    //     cleanup. router.back() runs even on server failure (no state
    //     drift, gallery just refetches on focus); local cleanup only
    //     runs after the server confirms.
    const doServerThenLocal = async () => {
      router.back();
      try {
        if (mediaId !== undefined) {
          await api.deleteMedia(mediaId);
        }
        await deletePhoto(photoId);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        showToast(
          e instanceof Error ? e.message : "Couldn't delete photo.",
        );
      }
    };

    // No server media row → local-only path (failed/pending upload).
    // Same UX as the previous simple-confirm flow used to be.
    if (mediaId === undefined) {
      if (Platform.OS === "web") {
        router.back();
        await deletePhoto(photoId);
        return;
      }
      Alert.alert("Delete photo?", "This will permanently remove the photo.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            router.back();
            await deletePhoto(photoId);
          },
        },
      ]);
      return;
    }

    // Server-backed path: fetch refs (with spinner), then confirm.
    setTrashLoading(true);
    let refsMessage = "";
    try {
      const refs = await api.getMediaReferences(mediaId);
      refsMessage = buildMediaReferencesMessage(refs);
    } catch (e) {
      setTrashLoading(false);
      if (e instanceof ApiError && e.status === 401) return;
      showToast(
        e instanceof Error ? e.message : "Couldn't check references.",
      );
      return;
    }
    setTrashLoading(false);

    const body = refsMessage || "This will permanently remove the photo.";
    if (Platform.OS === "web") return doServerThenLocal();
    Alert.alert("Delete photo?", body, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: doServerThenLocal },
    ]);
  };

  const onDownload = async () => {
    if (Platform.OS === "web") {
      Alert.alert(
        "Download",
        "Saving to camera roll only works on the iOS/Android build.",
      );
      return;
    }
    try {
      // writeOnly: request save-only access. Broad media-read perms were
      // stripped for Play policy; saveToLibraryAsync needs only write.
      const perm = await MediaLibrary.requestPermissionsAsync(true);
      if (perm.status !== "granted") {
        Alert.alert("Photos permission needed", "Allow access to save photos.");
        return;
      }
      await MediaLibrary.saveToLibraryAsync(currentPhoto.uri);
      Alert.alert("Saved", "Photo saved to your camera roll.");
    } catch (e) {
      Alert.alert(
        "Couldn't save",
        e instanceof Error ? e.message : "Unknown error",
      );
    }
  };

  const currentStrokeList = strokesById[currentPhoto.id] ?? [];
  const editOthers = othersById[currentPhoto.id] ?? [];

  return (
    <View style={styles.bg}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Top bar — persists across both branches. */}
      <View style={[styles.topBar, { paddingTop: insets.top + 6 }]}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Close photo"
          style={styles.iconBtn}
        >
          <Feather name="x" size={20} color="#fff" />
        </Pressable>
        <Text style={styles.counter}>
          {currentIndex + 1} of {projectPhotos.length}
        </Text>
      </View>

      {/* Photo display — branched by edit mode.
          Read mode: react-native-awesome-gallery provides pinch-to-zoom,
          pan, swipe-to-dismiss, and horizontal pager between siblings.
          Edit mode: a single bespoke canvas with the existing raw
          responder handlers; no zoom, no pager. Render branches are
          mutually exclusive — the gallery fully unmounts on entering
          edit mode (taking its gestures with it) and remounts at
          currentIndex on exit. */}
      {editing ? (
        <AnnotationEditor
          photoUri={currentPhoto.uri}
          ownStrokes={currentStrokeList}
          othersStrokes={editOthers}
          color={color}
          onColorChange={setColor}
          size={size}
          onSizeChange={setSize}
          onCommit={(s) => void commitStroke(s)}
          onUpdateStroke={(s) => void replaceStroke(s)}
          onDeleteStroke={(id) => void deleteStroke(id)}
          onClear={() => void clearAll()}
          onDone={() => setEditing(false)}
          // Directly below the parent's persistent row 1 (30px buttons +
          // 2×6 padding = 42) plus the panel's 8px gap — same spot the
          // rows occupied when they lived inside the tools panel.
          panelTop={insets.top + 56 + 42 + 8}
        />
      ) : (
        <Gallery
          data={projectPhotos}
          keyExtractor={(p: Photo) => p.id}
          initialIndex={currentIndex}
          onIndexChange={(i: number) => setCurrentIndex(i)}
          onSwipeToClose={() => router.back()}
          renderItem={({
            item,
            setImageDimensions,
          }: {
            item: Photo;
            index: number;
            setImageDimensions: (d: { width: number; height: number }) => void;
          }) => {
            if (item.isVideo) {
              // Videos render through expo-video, not <Image>. Seed a
              // non-zero size after mount so the gallery's pinch/zoom math
              // doesn't treat the item as 0×0; native controls handle
              // playback.
              return (
                <View style={StyleSheet.absoluteFill}>
                  <VideoGalleryItem
                    uri={item.uri}
                    onReady={() =>
                      setImageDimensions({
                        width: readBox.w || 1,
                        height: readBox.h || 1,
                      })
                    }
                  />
                </View>
              );
            }
            return (
              <View
                style={StyleSheet.absoluteFill}
                onLayout={(e) => {
                  const w = e.nativeEvent.layout.width;
                  const h = e.nativeEvent.layout.height;
                  setReadBox((prev) =>
                    prev.w === w && prev.h === h ? prev : { w, h },
                  );
                }}
              >
                <Image
                  source={{ uri: item.uri }}
                  style={StyleSheet.absoluteFill}
                  contentFit="contain"
                  onLoad={(e) => {
                    // REQUIRED by react-native-awesome-gallery — without
                    // this its zoom math treats the image as 0×0 and
                    // pinch breaks. expo-image's onLoad gives us the
                    // intrinsic pixel size of the source. Also captured
                    // per-photo to compute the fitted-rect annotation
                    // basis below.
                    const w = e.source?.width;
                    const h = e.source?.height;
                    if (w && h) {
                      setImageDimensions({ width: w, height: h });
                      setImgDimsById((prev) =>
                        prev[item.id]?.w === w && prev[item.id]?.h === h
                          ? prev
                          : { ...prev, [item.id]: { w, h } },
                      );
                    }
                  }}
                />
                {/* Read mode renders the photo's UNION render set
                    (item.annotations = others + own) via the shared
                    memoized layer — all six stroke types, denormalized
                    against this photo's FITTED IMAGE RECT (web-parity
                    basis), not the container. The gallery wraps
                    renderItem in an Animated.View whose transform is
                    [translateX, translateY, scale]; both the Image AND
                    this layer are inside that wrapper, so pinch/pan
                    scales them together — annotations stay pinned to
                    their photo pixels at every zoom level. Until the
                    intrinsic size arrives, render nothing rather than
                    a frame in the wrong basis. */}
                {(() => {
                  const dims = imgDimsById[item.id];
                  const rect = dims
                    ? fittedContainRect(readBox.w, readBox.h, dims.w, dims.h)
                    : null;
                  if (!rect) return null;
                  return (
                    <View
                      pointerEvents="none"
                      style={{
                        position: "absolute",
                        left: rect.x,
                        top: rect.y,
                        width: rect.w,
                        height: rect.h,
                      }}
                    >
                      <AnnotationLayer
                        strokes={item.annotations ?? []}
                        width={rect.w}
                        height={rect.h}
                      />
                    </View>
                  );
                })()}
              </View>
            );
          }}
        />
      )}

      {/* Tools panel (top-left) — persists across both branches. */}
      <View style={[styles.toolsPanel, { top: insets.top + 56 }]}>
        <View style={styles.toolRow}>
          <ToolButton
            active={editing}
            onPress={() => setEditing((v) => !v)}
            icon="edit-2"
            disabled={currentPhoto?.isVideo}
            label={editing ? "Stop drawing" : "Draw on photo"}
          />
          <ToolButton
            onPress={onDownload}
            icon="download"
            label="Save photo to camera roll"
          />
          <ToolButton
            onPress={undo}
            icon="rotate-ccw"
            disabled={currentStrokeList.length === 0}
            label="Undo last stroke"
          />
          {trashLoading ? (
            // Match ToolButton footprint so the toolbar doesn't reflow.
            // We disable the press surface entirely while the references
            // fetch is in flight — a second tap during the round-trip
            // would just queue another dialog.
            <View style={styles.trashSpinner}>
              <ActivityIndicator color="#ef4444" />
            </View>
          ) : (
            <ToolButton
              onPress={() => void onDelete()}
              icon="trash-2"
              tint="#ef4444"
              label="Delete photo"
            />
          )}
        </View>
        {/* Edit-mode rows (colors / sizes / clear / save + tool scaffold)
            now render inside AnnotationEditor, absolutely positioned to
            the same spot below this row. */}
      </View>

      {/* Caption / metadata + comments — only when not editing (preserved
          behavior). KeyboardAvoidingView lifts the whole bottom sheet so
          the comment input stays visible above the keyboard on iOS. */}
      {!editing ? (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.metaWrap}
        >
          <ScrollView
            style={styles.metaScroll}
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingVertical: 10,
            }}
            keyboardShouldPersistTaps="handled"
          >
            {currentPhoto.note ? (
              <Text style={styles.metaCaption}>{currentPhoto.note}</Text>
            ) : null}
            {currentPhoto.takenAt ? (
              <Text style={styles.metaSub}>
                {new Date(currentPhoto.takenAt).toLocaleString()}
              </Text>
            ) : null}
            {currentPhoto.latitude != null && currentPhoto.longitude != null ? (
              <Text style={styles.metaSub}>
                {currentPhoto.latitude.toFixed(5)},{" "}
                {currentPhoto.longitude.toFixed(5)}
              </Text>
            ) : null}

            {/* Comments — hidden entirely for local-only photos (no
                backend media row yet, so there's nothing to comment on). */}
            {currentMediaId !== undefined ? (
              <View style={styles.commentsBlock}>
                <Text style={styles.commentsHeader}>Comments</Text>
                {comments === null ? (
                  <ActivityIndicator
                    size="small"
                    color="#f09004"
                    style={{ alignSelf: "flex-start", marginVertical: 6 }}
                  />
                ) : commentsError ? (
                  <Text style={styles.commentEmpty}>
                    Couldn't load comments.
                  </Text>
                ) : comments.length === 0 ? (
                  <Text style={styles.commentEmpty}>No comments yet.</Text>
                ) : (
                  comments.map((c) => (
                    <View key={c.id} style={styles.commentItem}>
                      <View style={styles.commentTopRow}>
                        <Text style={styles.commentAuthor}>
                          {commentAuthorName(c)}
                        </Text>
                        <Text style={styles.commentDate}>
                          {formatCommentDate(c.createdAt)}
                        </Text>
                      </View>
                      <Text style={styles.commentText}>{c.content}</Text>
                    </View>
                  ))
                )}
              </View>
            ) : null}
          </ScrollView>

          {currentMediaId !== undefined ? (
            <View
              style={[
                styles.commentInputRow,
                { paddingBottom: insets.bottom + 8 },
              ]}
            >
              <TextInput
                value={commentDraft}
                onChangeText={setCommentDraft}
                placeholder="Add Comment"
                placeholderTextColor="rgba(255,255,255,0.45)"
                style={styles.commentInput}
                multiline
                editable={!postingComment}
                accessibilityLabel="Add Comment"
              />
              <Pressable
                onPress={() => void onPostComment()}
                disabled={postingComment || commentDraft.trim().length === 0}
                accessibilityRole="button"
                accessibilityLabel="Post comment"
                accessibilityState={{
                  disabled:
                    postingComment || commentDraft.trim().length === 0,
                  busy: postingComment,
                }}
                style={[
                  styles.commentPostBtn,
                  {
                    opacity:
                      postingComment || commentDraft.trim().length === 0
                        ? 0.5
                        : 1,
                  },
                ]}
              >
                {postingComment ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Feather name="send" size={16} color="#fff" />
                )}
              </Pressable>
            </View>
          ) : (
            <View style={{ height: insets.bottom + 8 }} />
          )}
        </KeyboardAvoidingView>
      ) : null}
    </View>
  );
}

/** Author display name; the `user` join is absent for deleted authors. */
function commentAuthorName(c: BackendCommentResponse): string {
  const name = [c.user?.firstName, c.user?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || "Deleted user";
}

/**
 * "Jul 23, 2026, 5:29 PM" in device-local time — matches the format the
 * web comments UI uses.
 */
function formatCommentDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ToolButton({
  icon,
  onPress,
  active,
  disabled,
  tint,
  label,
}: {
  icon: keyof typeof Feather.glyphMap;
  onPress: () => void;
  active?: boolean;
  disabled?: boolean;
  tint?: string;
  label: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      style={[
        styles.toolBtn,
        {
          backgroundColor: active ? "#F09001" : "transparent",
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      <Feather
        name={icon}
        size={16}
        color={active ? "#111" : tint || "#111"}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: "#000" },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 8,
    zIndex: 10,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  counter: {
    color: "rgba(255,255,255,0.85)",
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    backgroundColor: "rgba(0,0,0,0.45)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 100,
    overflow: "hidden",
  },
  toolsPanel: {
    position: "absolute",
    left: 12,
    gap: 8,
    zIndex: 20,
  },
  toolRow: {
    flexDirection: "row",
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 8,
    alignItems: "center",
  },
  toolBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  // Sized to match ToolButton (30×30) so swapping the trash icon for a
  // spinner during the references fetch doesn't reflow the toolbar.
  trashSpinner: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  metaWrap: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  // Height cap moved off metaWrap onto the inner scroller so the comment
  // input row below it is never clipped by the old maxHeight.
  metaScroll: {
    maxHeight: 240,
  },
  commentsBlock: {
    marginTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.25)",
    paddingTop: 8,
  },
  commentsHeader: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    marginBottom: 4,
  },
  commentEmpty: {
    color: "rgba(255,255,255,0.6)",
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    marginVertical: 4,
  },
  commentItem: {
    marginBottom: 8,
  },
  commentTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 8,
  },
  commentAuthor: {
    color: "#f09004",
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    flexShrink: 1,
  },
  commentDate: {
    color: "rgba(255,255,255,0.55)",
    fontFamily: "Inter_400Regular",
    fontSize: 11,
  },
  commentText: {
    color: "#fff",
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    marginTop: 2,
  },
  commentInputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.25)",
  },
  commentInput: {
    flex: 1,
    color: "#fff",
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
    maxHeight: 90,
  },
  commentPostBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#f09004",
    alignItems: "center",
    justifyContent: "center",
  },
  metaCaption: {
    color: "#fff",
    fontFamily: "Inter_500Medium",
    fontSize: 14,
    marginBottom: 4,
  },
  metaSub: {
    color: "rgba(255,255,255,0.75)",
    fontFamily: "Inter_400Regular",
    fontSize: 12,
  },
});
