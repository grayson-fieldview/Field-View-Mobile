import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as MediaLibrary from "expo-media-library";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Gallery from "react-native-awesome-gallery";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";

import { useData } from "@/contexts/DataContext";
import { useToast } from "@/contexts/ToastContext";
import { rawToCanonical, toPixels } from "@/services/annotations";
import { ApiError, api, buildMediaReferencesMessage } from "@/services/api";
import { isRenderablePencilStroke } from "@/services/types";
import type { AnnotationStroke, Photo, StoredStroke } from "@/services/types";

const COLORS = ["#ef4444", "#22c55e", "#3b82f6", "#F09001", "#a855f7", "#111111"];
const SIZES = [3, 6, 12];

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

  const currentStroke = useRef<AnnotationStroke | null>(null);
  const [, force] = useState(0);

  // Captured drawing-canvas size. Kept as a ref (read synchronously at draw
  // time so freshly-drawn px points record the box they were laid out
  // against) AND mirrored to state so the render can denormalize canonical
  // strokes to px against the current box.
  const canvasSize = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const [editBox, setEditBox] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });
  // Read-mode (gallery) box. Items are absoluteFill, so a single captured
  // size denormalizes every sibling's canonical strokes.
  const [readBox, setReadBox] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });

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
        if (ok) dirtyRef.current.delete(pid);
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
      })();
    }
  };
  useEffect(() => () => flushRef.current(), []);

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

  const startStroke = (x: number, y: number) => {
    if (!editing) return;
    currentStroke.current = {
      color,
      size,
      points: [{ x, y }],
      canvasW: canvasSize.current.w || undefined,
      canvasH: canvasSize.current.h || undefined,
    };
    force((n) => n + 1);
  };
  const extendStroke = (x: number, y: number) => {
    if (!editing || !currentStroke.current) return;
    currentStroke.current.points.push({ x, y });
    force((n) => n + 1);
  };
  // Persist a buffer change locally (offline buffer + optimistic render set)
  // and mark the photo dirty for the next server flush. The local render set
  // (Photo.annotations) is the union of others + own so thumbnails / read
  // mode stay correct without waiting for the server round-trip.
  const persistLocalUnion = async (pid: string, ownNext: StoredStroke[]) => {
    dirtyRef.current.add(pid);
    const others = othersById[pid] ?? [];
    await updatePhoto(pid, { annotations: [...others, ...ownNext] });
  };

  const endStroke = async () => {
    if (!editing) return;
    const s = currentStroke.current;
    currentStroke.current = null;
    if (!s || s.points.length < 2) {
      force((n) => n + 1);
      return;
    }
    // Convert the freshly-drawn raw px stroke to canonical 0..1 at the edge,
    // stamping type "pencil". The buffer is uniformly canonical from here.
    const canonical = rawToCanonical({
      ...s,
      canvasW: canvasSize.current.w || undefined,
      canvasH: canvasSize.current.h || undefined,
    });
    const pid = currentPhoto.id;
    const next = [...(strokesById[pid] ?? []), canonical];
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
      const perm = await MediaLibrary.requestPermissionsAsync();
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

  // Edit-mode render set, resolved to px against the edit canvas box:
  //   others' canonical strokes + own canonical buffer (denormalized)
  //   + the live in-progress raw px stroke (already in canvas px space).
  // The gallery (read-only) branch never sees `live` because edit mode
  // unmounts the gallery.
  const live = currentStroke.current;
  const currentStrokeList = strokesById[currentPhoto.id] ?? [];
  const editOthers = othersById[currentPhoto.id] ?? [];
  const editStrokesPx = [
    ...editOthers.map((s) => toPixels(s, editBox.w, editBox.h)),
    ...currentStrokeList.map((s) => toPixels(s, editBox.w, editBox.h)),
    ...(live
      ? [{ type: "pencil", color: live.color, size: live.size, points: live.points }]
      : []),
  ].filter(isRenderablePencilStroke);

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
        <View
          style={StyleSheet.absoluteFill}
          onLayout={(e) => {
            const w = e.nativeEvent.layout.width;
            const h = e.nativeEvent.layout.height;
            canvasSize.current = { w, h };
            setEditBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
          }}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={(e) =>
            startStroke(e.nativeEvent.locationX, e.nativeEvent.locationY)
          }
          onResponderMove={(e) =>
            extendStroke(e.nativeEvent.locationX, e.nativeEvent.locationY)
          }
          onResponderRelease={endStroke}
          onResponderTerminate={endStroke}
        >
          <Image
            source={{ uri: currentPhoto.uri }}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
          />
          <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
            {editStrokesPx.map((s, i) => (
              // editStrokesPx is already px-resolved and pencil-filtered:
              // others + own canonical buffer denormalized against the
              // edit box, plus the live raw px stroke. The filter upstream
              // drops text/arrow/etc. strokes (mobile renderer is
              // pencil-only).
              <Path
                key={i}
                d={pointsToPath(s.points)}
                stroke={s.color}
                strokeWidth={s.size}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            ))}
          </Svg>
        </View>
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
            // Read mode renders the photo's UNION render set
            // (item.annotations = others + own, kept current by
            // loadPhotoAnnotations and every local buffer write),
            // denormalized to px against the captured read box and
            // pencil-filtered. canonical 0..1 strokes scale to the box;
            // legacy/px strokes are normalized by toPixels first.
            const saved = (item.annotations ?? [])
              .map((s) => toPixels(s, readBox.w, readBox.h))
              .filter(isRenderablePencilStroke);
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
                    // intrinsic pixel size of the source.
                    const w = e.source?.width;
                    const h = e.source?.height;
                    if (w && h) setImageDimensions({ width: w, height: h });
                  }}
                />
                {saved.length > 0 ? (
                  // The gallery wraps renderItem in an Animated.View whose
                  // transform is [translateX, translateY, scale]. Both
                  // the Image AND this Svg are inside that wrapper, so
                  // pinch/pan scales them together — annotations stay
                  // pinned to their photo pixels at every zoom level.
                  <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
                    {saved.map((s, i) => (
                      <Path
                        key={i}
                        d={pointsToPath(s.points)}
                        stroke={s.color}
                        strokeWidth={s.size}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    ))}
                  </Svg>
                ) : null}
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

        {editing ? (
          <>
            <View style={styles.toolRow}>
              {COLORS.map((c) => (
                <Pressable
                  key={c}
                  onPress={() => setColor(c)}
                  accessibilityRole="button"
                  accessibilityLabel={`Color ${c}`}
                  accessibilityState={{ selected: color === c }}
                  style={[
                    styles.swatch,
                    {
                      backgroundColor: c,
                      borderColor: color === c ? "#fff" : "transparent",
                    },
                  ]}
                />
              ))}
            </View>
            <View style={styles.toolRow}>
              <Text style={styles.sizeLabel}>Size</Text>
              {SIZES.map((s) => (
                <Pressable
                  key={s}
                  onPress={() => setSize(s)}
                  accessibilityRole="button"
                  accessibilityLabel={`Brush size ${s}`}
                  accessibilityState={{ selected: size === s }}
                  style={[
                    styles.sizeDot,
                    {
                      borderColor: size === s ? "#fff" : "transparent",
                    },
                  ]}
                >
                  <View
                    style={{
                      width: s * 1.5,
                      height: s * 1.5,
                      borderRadius: s,
                      backgroundColor: color,
                    }}
                  />
                </Pressable>
              ))}
              {currentStrokeList.length > 0 ? (
                <Pressable onPress={clearAll} style={styles.clearBtn}>
                  <Text style={styles.clearTxt}>Clear all</Text>
                </Pressable>
              ) : null}
              <Pressable
                onPress={() => setEditing(false)}
                accessibilityRole="button"
                accessibilityLabel="Save annotations"
                style={styles.saveBtn}
              >
                <Text style={styles.saveTxt}>Save</Text>
              </Pressable>
            </View>
          </>
        ) : null}
      </View>

      {/* Caption / metadata — only when not editing (preserved behavior). */}
      {!editing ? (
        <ScrollView
          style={[
            styles.metaWrap,
            { paddingBottom: insets.bottom + 16 },
          ]}
          contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 10 }}
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
        </ScrollView>
      ) : null}
    </View>
  );
}

function pointsToPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++)
    d += ` L${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`;
  return d;
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
  swatch: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
  },
  sizeLabel: {
    color: "#111",
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    marginRight: 4,
  },
  sizeDot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  clearBtn: {
    marginLeft: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "#fee2e2",
  },
  clearTxt: {
    color: "#991b1b",
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
  },
  saveBtn: {
    marginLeft: "auto",
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "#F09001",
  },
  saveTxt: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  metaWrap: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: 140,
    backgroundColor: "rgba(0,0,0,0.5)",
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
