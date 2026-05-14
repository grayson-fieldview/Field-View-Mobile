import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as MediaLibrary from "expo-media-library";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
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
import { isRenderablePencilStroke } from "@/services/types";
import type { AnnotationStroke, Photo } from "@/services/types";

const COLORS = ["#ef4444", "#22c55e", "#3b82f6", "#F09001", "#a855f7", "#111111"];
const SIZES = [3, 6, 12];

export default function PhotoViewerScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { photos, updatePhoto, deletePhoto } = useData();

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
  // Per-photo working stroke state, keyed by photo id.
  const [strokesById, setStrokesById] = useState<
    Record<string, AnnotationStroke[]>
  >(() => {
    const init: Record<string, AnnotationStroke[]> = {};
    for (const p of projectPhotos) init[p.id] = p.annotations ?? [];
    return init;
  });
  // Re-seed if the photo set changes (e.g. after delete).
  useEffect(() => {
    setStrokesById((prev) => {
      const next = { ...prev };
      for (const p of projectPhotos) {
        if (!(p.id in next)) next[p.id] = p.annotations ?? [];
      }
      return next;
    });
  }, [projectPhotos]);

  const currentStroke = useRef<AnnotationStroke | null>(null);
  const [, force] = useState(0);

  // Captured drawing-canvas size, used so freshly-drawn strokes record
  // the canvas dimensions they were laid out against (for future
  // re-render at different sizes, mirroring the web app's behavior).
  const canvasSize = useRef<{ w: number; h: number }>({ w: 0, h: 0 });

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
  const endStroke = async () => {
    if (!editing) return;
    const s = currentStroke.current;
    currentStroke.current = null;
    if (!s || s.points.length < 2) {
      force((n) => n + 1);
      return;
    }
    const pid = currentPhoto.id;
    const next = [...(strokesById[pid] ?? []), s];
    setStrokesById((prev) => ({ ...prev, [pid]: next }));
    await updatePhoto(pid, { annotations: next });
  };

  const undo = async () => {
    const pid = currentPhoto.id;
    const list = strokesById[pid] ?? [];
    if (list.length === 0) return;
    const next = list.slice(0, -1);
    setStrokesById((prev) => ({ ...prev, [pid]: next }));
    await updatePhoto(pid, { annotations: next });
  };

  const clearAll = async () => {
    const pid = currentPhoto.id;
    setStrokesById((prev) => ({ ...prev, [pid]: [] }));
    await updatePhoto(pid, { annotations: [] });
  };

  const onDelete = () => {
    const photoId = currentPhoto.id;
    const doIt = async () => {
      // Navigate back FIRST so we don't briefly render the "Photo not found"
      // fallback (the URL `id` would dangle after the photo is removed from
      // state). The actual delete happens after the screen is dismissed.
      router.back();
      await deletePhoto(photoId);
    };
    if (Platform.OS === "web") return doIt();
    Alert.alert("Delete photo?", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: doIt },
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

  // Edit-mode-only: combine committed strokes with the live in-progress
  // stroke so the user sees their finger trail. The gallery (read-only)
  // branch never sees `live` because edit mode unmounts the gallery.
  const live = currentStroke.current;
  const currentStrokeList = strokesById[currentPhoto.id] ?? [];
  const allStrokes = live
    ? [...currentStrokeList, live]
    : currentStrokeList;

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
            canvasSize.current = {
              w: e.nativeEvent.layout.width,
              h: e.nativeEvent.layout.height,
            };
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
            {allStrokes.filter(isRenderablePencilStroke).map((s, i) => (
              // Filter guards against text/arrow/etc. strokes that the
              // web app may write into a photo's annotations array
              // (mobile renderer is pencil-only). Locally-created
              // strokes always pass — they have no `type` field and
              // always carry a non-empty points array.
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
            // Render BOTH committed-but-unsaved strokes from the local
            // edit buffer (strokesById) AND the photo's persisted
            // annotations as a fallback, so swiping to a sibling that
            // wasn't seeded yet still shows its saved annotations.
            const saved = (
              strokesById[item.id] ?? item.annotations ?? []
            ).filter(isRenderablePencilStroke);
            return (
              <View style={StyleSheet.absoluteFill}>
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
          <ToolButton
            onPress={onDelete}
            icon="trash-2"
            tint="#ef4444"
            label="Delete photo"
          />
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
