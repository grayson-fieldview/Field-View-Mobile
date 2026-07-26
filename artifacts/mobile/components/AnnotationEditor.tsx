import { Image } from "expo-image";
import React, { useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, {
  Circle,
  Line,
  Path,
  Rect,
  Text as SvgText,
} from "react-native-svg";

import {
  arrowHeadPath,
  hasMinDrag,
  rawToCanonical,
  strokeToRenderShape,
} from "@/services/annotations";
import type { RenderShape } from "@/services/annotations";
import type {
  AnnotationStroke,
  CanonicalStroke,
  KnownStrokeType,
  StoredStroke,
} from "@/services/types";

export const COLORS = [
  "#ef4444",
  "#22c55e",
  "#3b82f6",
  "#F09001",
  "#a855f7",
  "#111111",
];
export const SIZES = [3, 6, 12];

export function pointsToPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++)
    d += ` L${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`;
  return d;
}

/**
 * Render one resolved shape. Geometry conventions (arrowhead derivation,
 * circle = center + radius point, text top-anchored) match the production
 * web canvas renderer — see services/annotations.ts.
 *
 * Text: the web draws with canvas textBaseline="top"; SVG <Text> anchors
 * on the alphabetic baseline, and alignmentBaseline isn't reliable across
 * RN SVG platforms, so we offset the baseline down by ~0.8em from the
 * stored top-left y. Approximation — flagged, not pixel-exact vs web.
 */
function renderShape(shape: RenderShape, key: string | number) {
  switch (shape.kind) {
    case "pencil":
      return (
        <Path
          key={key}
          d={pointsToPath(shape.points)}
          stroke={shape.color}
          strokeWidth={shape.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      );
    case "line":
      return (
        <Line
          key={key}
          x1={shape.x1}
          y1={shape.y1}
          x2={shape.x2}
          y2={shape.y2}
          stroke={shape.color}
          strokeWidth={shape.strokeWidth}
          strokeLinecap="round"
        />
      );
    case "arrow":
      return (
        <React.Fragment key={key}>
          <Line
            x1={shape.x1}
            y1={shape.y1}
            x2={shape.x2}
            y2={shape.y2}
            stroke={shape.color}
            strokeWidth={shape.strokeWidth}
            strokeLinecap="round"
          />
          <Path
            d={arrowHeadPath(
              shape.x1,
              shape.y1,
              shape.x2,
              shape.y2,
              shape.strokeWidth,
            )}
            stroke={shape.color}
            strokeWidth={shape.strokeWidth}
            strokeLinecap="round"
            fill="none"
          />
        </React.Fragment>
      );
    case "circle":
      return (
        <Circle
          key={key}
          cx={shape.cx}
          cy={shape.cy}
          r={shape.r}
          stroke={shape.color}
          strokeWidth={shape.strokeWidth}
          fill="none"
        />
      );
    case "rectangle":
      return (
        <Rect
          key={key}
          x={shape.x}
          y={shape.y}
          width={shape.w}
          height={shape.h}
          stroke={shape.color}
          strokeWidth={shape.strokeWidth}
          fill="none"
        />
      );
    case "text":
      return (
        <SvgText
          key={key}
          x={shape.x}
          y={shape.y + shape.fontSize * 0.8}
          fill={shape.color}
          fontSize={shape.fontSize}
          fontWeight="600"
        >
          {shape.content}
        </SvgText>
      );
  }
}

/**
 * Pure, memoized SVG layer for a set of COMMITTED canonical strokes.
 * Renders all six known stroke types; unknown types resolve to null and
 * are skipped (their data is still preserved end-to-end).
 *
 * Memoization contract: parents must keep `strokes` referentially stable
 * between renders that don't change it (the photo screen's per-photo
 * buffers already are). The live in-progress stroke is intentionally NOT
 * part of this layer, so per-move re-renders never re-resolve or re-draw
 * committed strokes.
 */
export const AnnotationLayer = React.memo(function AnnotationLayer({
  strokes,
  width,
  height,
}: {
  strokes: StoredStroke[];
  width: number;
  height: number;
}) {
  const shapes = useMemo(
    () =>
      strokes
        .map((s, i) => ({ shape: strokeToRenderShape(s, width, height), i }))
        .filter(
          (x): x is { shape: RenderShape; i: number } => x.shape !== null,
        ),
    [strokes, width, height],
  );
  if (!width || !height || shapes.length === 0) return null;
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
      {shapes.map(({ shape, i }) => renderShape(shape, strokes[i]?.id ?? i))}
    </Svg>
  );
});

/**
 * Tool scaffold. Phase 1 ships pencil only — later phases append entries
 * here and the toolbar/commit path already respect the selection.
 */
const TOOLS: { key: KnownStrokeType; label: string }[] = [
  { key: "pencil", label: "Pencil" },
];

/**
 * Interactive annotation canvas — extracted from app/photo/[id].tsx
 * (behavior-preserving). Owns only the DRAWING session: the live
 * in-progress stroke, canvas layout box, and the active tool. The parent
 * keeps the canonical stroke buffers, dirty tracking, server flushes,
 * undo, and the persistent (row-1) toolbar; this component commits each
 * finished stroke upward via onCommit.
 */
export function AnnotationEditor({
  photoUri,
  ownStrokes,
  othersStrokes,
  color,
  onColorChange,
  size,
  onSizeChange,
  onCommit,
  onClear,
  onDone,
  panelTop,
}: {
  photoUri: string;
  ownStrokes: StoredStroke[];
  othersStrokes: StoredStroke[];
  color: string;
  onColorChange: (c: string) => void;
  size: number;
  onSizeChange: (s: number) => void;
  onCommit: (stroke: CanonicalStroke) => void;
  onClear: () => void;
  onDone: () => void;
  /** Absolute top (px) for the edit tool rows, below the parent's row 1. */
  panelTop: number;
}) {
  // Active authoring tool. Commit reads the type from here instead of
  // hardcoding "pencil" — Phase 2 tools plug in without touching commit.
  const [activeTool, setActiveTool] = useState<KnownStrokeType>("pencil");

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

  const startStroke = (x: number, y: number) => {
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
    if (!currentStroke.current) return;
    currentStroke.current.points.push({ x, y });
    force((n) => n + 1);
  };
  const endStroke = () => {
    const s = currentStroke.current;
    currentStroke.current = null;
    // Discard taps / sub-threshold drags: the server has no min-length on
    // `points`, so a zero-length arrow/circle would validate and sync.
    if (!s || !hasMinDrag(s.points)) {
      force((n) => n + 1);
      return;
    }
    // Convert the freshly-drawn raw px stroke to canonical 0..1 at the
    // edge; the stroke type comes from the active tool.
    onCommit(
      rawToCanonical(
        {
          ...s,
          canvasW: canvasSize.current.w || undefined,
          canvasH: canvasSize.current.h || undefined,
        },
        activeTool,
      ),
    );
  };

  // Committed strokes render through the memoized AnnotationLayer; the
  // per-move force() re-render only re-draws the live path below it.
  const committed = useMemo(
    () => [...othersStrokes, ...ownStrokes],
    [othersStrokes, ownStrokes],
  );
  const live = currentStroke.current;

  return (
    <>
      <View
        style={StyleSheet.absoluteFill}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          const h = e.nativeEvent.layout.height;
          canvasSize.current = { w, h };
          setEditBox((prev) =>
            prev.w === w && prev.h === h ? prev : { w, h },
          );
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
          source={{ uri: photoUri }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
        />
        <AnnotationLayer
          strokes={committed}
          width={editBox.w}
          height={editBox.h}
        />
        {live && live.points.length > 0 ? (
          <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
            <Path
              d={pointsToPath(live.points)}
              stroke={live.color}
              strokeWidth={live.size}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </Svg>
        ) : null}
      </View>

      {/* Edit tool rows — same layout/styles as when they lived inside the
          parent's tools panel (left 12, stacked, gap 8). */}
      <View style={[styles.editPanel, { top: panelTop }]}>
        {TOOLS.length > 1 ? (
          <View style={styles.toolRow}>
            {TOOLS.map((t) => (
              <Pressable
                key={t.key}
                onPress={() => setActiveTool(t.key)}
                accessibilityRole="button"
                accessibilityLabel={t.label}
                accessibilityState={{ selected: activeTool === t.key }}
                style={[
                  styles.toolChip,
                  activeTool === t.key && styles.toolChipActive,
                ]}
              >
                <Text style={styles.toolChipTxt}>{t.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <View style={styles.toolRow}>
          {COLORS.map((c) => (
            <Pressable
              key={c}
              onPress={() => onColorChange(c)}
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
              onPress={() => onSizeChange(s)}
              accessibilityRole="button"
              accessibilityLabel={`Brush size ${s}`}
              accessibilityState={{ selected: size === s }}
              style={[
                styles.sizeDot,
                { borderColor: size === s ? "#fff" : "transparent" },
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
          {ownStrokes.length > 0 ? (
            <Pressable onPress={onClear} style={styles.clearBtn}>
              <Text style={styles.clearTxt}>Clear all</Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={onDone}
            accessibilityRole="button"
            accessibilityLabel="Save annotations"
            style={styles.saveBtn}
          >
            <Text style={styles.saveTxt}>Save</Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  editPanel: {
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
  toolChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  toolChipActive: {
    backgroundColor: "#F09001",
  },
  toolChipTxt: {
    color: "#111",
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
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
});
