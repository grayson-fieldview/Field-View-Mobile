import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as MediaLibrary from "expo-media-library";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useMemo, useRef, useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";

import { useData } from "@/contexts/DataContext";
import type { AnnotationStroke } from "@/services/types";

const COLORS = ["#ef4444", "#22c55e", "#3b82f6", "#f59e0b", "#a855f7", "#111111"];
const SIZES = [3, 6, 12];

export default function PhotoViewerScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { photos, updatePhoto, deletePhoto } = useData();

  const photo = useMemo(() => photos.find((p) => p.id === id), [photos, id]);

  const [editing, setEditing] = useState(false);
  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState(SIZES[1]);
  const [strokes, setStrokes] = useState<AnnotationStroke[]>(
    photo?.annotations ?? [],
  );
  const currentStroke = useRef<AnnotationStroke | null>(null);
  const [, force] = useState(0);

  if (!photo) {
    return (
      <View style={styles.bg}>
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={{ color: "#fff", textAlign: "center", marginTop: 100 }}>
          Photo not found.
        </Text>
      </View>
    );
  }

  const projectIndex = photos
    .filter((p) => p.projectId === photo.projectId)
    .findIndex((p) => p.id === photo.id);
  const total = photos.filter((p) => p.projectId === photo.projectId).length;

  const startStroke = (x: number, y: number) => {
    if (!editing) return;
    currentStroke.current = { color, size, points: [{ x, y }] };
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
    const next = [...strokes, s];
    setStrokes(next);
    await updatePhoto(photo.id, { annotations: next });
  };

  const undo = async () => {
    if (strokes.length === 0) return;
    const next = strokes.slice(0, -1);
    setStrokes(next);
    await updatePhoto(photo.id, { annotations: next });
  };

  const clearAll = async () => {
    setStrokes([]);
    await updatePhoto(photo.id, { annotations: [] });
  };

  const onDelete = () => {
    const doIt = async () => {
      await deletePhoto(photo.id);
      router.back();
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
      await MediaLibrary.saveToLibraryAsync(photo.uri);
      Alert.alert("Saved", "Photo saved to your camera roll.");
    } catch (e) {
      Alert.alert(
        "Couldn't save",
        e instanceof Error ? e.message : "Unknown error",
      );
    }
  };

  const live = currentStroke.current;
  const allStrokes = live ? [...strokes, live] : strokes;

  return (
    <View style={styles.bg}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Top bar */}
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
          {projectIndex + 1} of {total}
        </Text>
      </View>

      {/* Photo + drawing canvas */}
      <View
        style={styles.canvasWrap}
        onStartShouldSetResponder={() => editing}
        onMoveShouldSetResponder={() => editing}
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
          source={{ uri: photo.uri }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
        />
        <Svg style={StyleSheet.absoluteFill}>
          {allStrokes.map((s, i) => (
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

      {/* Tools panel (top-left) */}
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
            disabled={strokes.length === 0}
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
              {strokes.length > 0 ? (
                <Pressable onPress={clearAll} style={styles.clearBtn}>
                  <Text style={styles.clearTxt}>Clear all</Text>
                </Pressable>
              ) : null}
            </View>
          </>
        ) : null}
      </View>

      {/* Caption / metadata */}
      {!editing ? (
        <ScrollView
          style={[
            styles.metaWrap,
            { paddingBottom: insets.bottom + 16 },
          ]}
          contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 10 }}
        >
          {photo.note ? (
            <Text style={styles.metaCaption}>{photo.note}</Text>
          ) : null}
          {photo.takenAt ? (
            <Text style={styles.metaSub}>
              {new Date(photo.takenAt).toLocaleString()}
            </Text>
          ) : null}
          {photo.latitude != null && photo.longitude != null ? (
            <Text style={styles.metaSub}>
              {photo.latitude.toFixed(5)}, {photo.longitude.toFixed(5)}
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
          backgroundColor: active ? "#f59e0b" : "transparent",
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
  },
  canvasWrap: { flex: 1 },
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
