import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Svg, {
  Circle,
  Line,
  Path,
  Rect,
  Text as SvgText,
} from "react-native-svg";

import {
  DEFAULT_FONT_SIZE,
  LEGACY_PEN_SIZES_PX,
  MAX_TEXT_CONTENT_LENGTH,
  TEXT_FONT_SIZES,
  arrowHeadPath,
  hasMinDrag,
  rawToCanonical,
  strokeToRenderShape,
  textToCanonical,
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
// The pen set doubles as the legacy-width snap target in
// services/annotations.ts — keep the two in lockstep.
export const SIZES: number[] = [...LEGACY_PEN_SIZES_PX];

/**
 * Flip to true once a device build confirms Android renders
 * alignmentBaseline="text-before-edge" at parity with web's canvas
 * textBaseline="top" (see the text case in renderShape). Until then
 * Android keeps the 0.8em approximation.
 */
const ANDROID_TEXT_BEFORE_EDGE_VERIFIED = false;

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
    case "text": {
      // Top-anchoring parity with web's canvas textBaseline="top".
      // iOS: alignmentBaseline="text-before-edge" — RNSVGTSpan.mm in
      // react-native-svg 15.12.1 implements it as baselineShift =
      // ascenderHeight, the direct text-top mapping. Android has the
      // same code in TSpanView.java, but its baseline handling is
      // historically patchy, so it KEEPS the 0.8em approximation until
      // a device build visually verifies parity — then flip
      // ANDROID_TEXT_BEFORE_EDGE_VERIFIED to true.
      const useBeforeEdge =
        Platform.OS === "ios" || ANDROID_TEXT_BEFORE_EDGE_VERIFIED;
      return (
        <SvgText
          key={key}
          x={shape.x}
          y={useBeforeEdge ? shape.y : shape.y + shape.fontSize * 0.8}
          alignmentBaseline={useBeforeEdge ? "text-before-edge" : undefined}
          fill={shape.color}
          fontSize={shape.fontSize}
          fontWeight="600"
        >
          {shape.content}
        </SvgText>
      );
    }
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
  // TEMP DIAG (Bug 2, build 39): canvas box + resolve rate. Logs only when
  // inputs change (useMemo-adjacent), not per render frame.
  useEffect(() => {
    console.log(
      `[annot-diag] AnnotationLayer box=${width}x${height}, strokes=${strokes.length}, resolved=${shapes.length}`,
    );
  }, [width, height, strokes.length, shapes.length]);
  if (!width || !height || shapes.length === 0) return null;
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
      {shapes.map(({ shape, i }) => renderShape(shape, strokes[i]?.id ?? i))}
    </Svg>
  );
});

/**
 * Live in-progress drag preview. Reads the raw px stroke from the
 * currentStroke ref (via prop) so the memoized AnnotationLayer above it
 * never re-resolves committed strokes on move. Geometry mirrors
 * strokeToRenderShape / renderShape exactly — arrow head derived, circle
 * = center + radius point — so the committed shape lands where the
 * preview showed it.
 */
function LivePreview({
  stroke,
  tool,
}: {
  stroke: AnnotationStroke;
  tool: KnownStrokeType;
}) {
  const pts = stroke.points;
  if (tool === "pencil" || pts.length < 2) {
    return (
      <Path
        d={pointsToPath(pts)}
        stroke={stroke.color}
        strokeWidth={stroke.size}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    );
  }
  const a = pts[0];
  const b = pts[pts.length - 1];
  const common = {
    stroke: stroke.color,
    strokeWidth: stroke.size,
    fill: "none" as const,
  };
  if (tool === "circle") {
    return (
      <Circle cx={a.x} cy={a.y} r={Math.hypot(b.x - a.x, b.y - a.y)} {...common} />
    );
  }
  if (tool === "rectangle") {
    return (
      <Rect
        x={Math.min(a.x, b.x)}
        y={Math.min(a.y, b.y)}
        width={Math.abs(b.x - a.x)}
        height={Math.abs(b.y - a.y)}
        {...common}
      />
    );
  }
  // arrow (and any future 2-point line-like tool)
  return (
    <>
      <Line x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeLinecap="round" {...common} />
      {tool === "arrow" ? (
        <Path
          d={arrowHeadPath(a.x, a.y, b.x, b.y, stroke.size)}
          strokeLinecap="round"
          {...common}
        />
      ) : null}
    </>
  );
}

/**
 * Authoring tools (Phase 2: pencil + arrow + circle + rectangle). All
 * shapes are single drag gestures through the same grant → move →
 * release pipeline; only the point-accumulation rule differs (pencil
 * appends, shapes track [start, current]). Icons, not text labels —
 * four chips of text don't fit a phone-width row.
 */
const TOOLS: {
  key: KnownStrokeType;
  label: string;
  icon: React.ComponentProps<typeof Feather>["name"];
}[] = [
  { key: "pencil", label: "Pencil", icon: "edit-2" },
  { key: "arrow", label: "Arrow", icon: "arrow-up-right" },
  { key: "circle", label: "Circle", icon: "circle" },
  { key: "rectangle", label: "Rectangle", icon: "square" },
  { key: "text", label: "Text", icon: "type" },
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
  // Tool FROZEN at gesture start. extendStroke, the live preview, and the
  // commit all read this snapshot — never the live activeTool — so
  // switching tools mid-drag can't mix accumulation semantics (append vs
  // replace-second-point) or commit a different type than was drawn.
  const strokeTool = useRef<KnownStrokeType>("pencil");
  const [, force] = useState(0);

  // Text tool: a tap opens an inline input anchored at the tap point
  // (raw px, TOP-LEFT of the text — web draws with textBaseline="top").
  // Commit on submit with non-empty trimmed content; cancel (dismiss or
  // empty) creates NOTHING — an empty content would 400 the whole row.
  const [pendingText, setPendingText] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [textDraft, setTextDraft] = useState("");
  const [fontSize, setFontSize] = useState<number>(DEFAULT_FONT_SIZE);
  // Anchor token, updated SYNCHRONOUSLY with every open/commit/cancel.
  // Blur and submit both pass the anchor they were rendered for; a
  // handler whose anchor no longer matches is stale (the session was
  // already finalized, or a re-tap re-anchored the input) and must
  // no-op. This makes commit/cancel deterministic regardless of
  // platform blur-vs-submit event ordering:
  //   submit → blur: submit commits + clears the ref; blur no-ops.
  //   re-tap while open: startStroke installs a NEW anchor first; the
  //   old input's blur no longer matches and can't cancel the new one.
  //   plain dismiss: anchor still matches → cancel, nothing saved.
  const pendingAnchorRef = useRef<{ x: number; y: number } | null>(null);

  const commitPendingText = (anchor: { x: number; y: number }) => {
    if (pendingAnchorRef.current !== anchor) return; // stale handler
    pendingAnchorRef.current = null;
    setPendingText(null);
    setTextDraft("");
    const stroke = textToCanonical({
      xPx: anchor.x,
      yPx: anchor.y,
      content: textDraft,
      color,
      fontSize,
      canvasW: canvasSize.current.w,
      canvasH: canvasSize.current.h,
    });
    if (stroke) onCommit(stroke); // null = empty/whitespace → cancelled
  };
  const cancelPendingText = (anchor?: { x: number; y: number } | null) => {
    // Called with an anchor from the input's blur (guarded), or with
    // none for unconditional dismissal (tool-switch draw).
    if (anchor !== undefined && pendingAnchorRef.current !== anchor) return;
    pendingAnchorRef.current = null;
    setPendingText(null);
    setTextDraft("");
  };

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
    if (activeTool === "text") {
      // Tap-to-place: no drag stroke. A second tap while the input is
      // open cancels the first (dismiss = save nothing) and re-anchors.
      const anchor = { x, y };
      pendingAnchorRef.current = anchor; // synchronous: outranks any in-flight blur
      setTextDraft("");
      setPendingText(anchor);
      return;
    }
    // Drawing with any other tool while a text input is open dismisses
    // it (dismiss = save nothing, per contract).
    if (pendingText) cancelPendingText();
    strokeTool.current = activeTool;
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
    const s = currentStroke.current;
    if (!s) return;
    if (strokeTool.current === "pencil") {
      s.points.push({ x, y });
    } else {
      // Shape tools hold exactly [start, current]: the current finger
      // position REPLACES the second point. Matches the wire contract —
      // arrow/rectangle: [start, end]; circle: [center, radiusPoint]
      // (drag starts at the CENTER; radius = distance to the finger).
      s.points[1] = { x, y };
    }
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
    // edge; the type comes from the TOOL SNAPSHOT taken at gesture start.
    // Shape strokes are hardened to exactly [start, end] here — the
    // accumulation rule already maintains that, but a malformed live
    // buffer must never reach the wire with extra points.
    const tool = strokeTool.current;
    const points =
      tool === "pencil" ? s.points : [s.points[0], s.points[s.points.length - 1]];
    onCommit(
      rawToCanonical(
        {
          ...s,
          points,
          canvasW: canvasSize.current.w || undefined,
          canvasH: canvasSize.current.h || undefined,
        },
        tool,
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
            <LivePreview stroke={live} tool={strokeTool.current} />
          </Svg>
        ) : null}
        {pendingText ? (
          // WYSIWYG placement: the input's own glyphs sit at the tap
          // point (top-left), styled exactly like the committed SVG text
          // (fontSize px, weight 600, active color).
          <TextInput
            value={textDraft}
            onChangeText={setTextDraft}
            autoFocus
            multiline={false}
            maxLength={MAX_TEXT_CONTENT_LENGTH}
            returnKeyType="done"
            onSubmitEditing={() => commitPendingText(pendingText)}
            onBlur={() => cancelPendingText(pendingText)}
            accessibilityLabel="Annotation text"
            placeholder="Text"
            placeholderTextColor="rgba(255,255,255,0.55)"
            style={[
              styles.textDraftInput,
              {
                left: pendingText.x,
                top: pendingText.y,
                fontSize,
                color,
                maxWidth: Math.max(80, editBox.w - pendingText.x - 8),
              },
            ]}
          />
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
                <Feather
                  name={t.icon}
                  size={16}
                  color={activeTool === t.key ? "#fff" : "#111"}
                />
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
          {activeTool === "text"
            ? // Text gets its OWN size ladder — the pen set {3,6,12} is
              // stroke widths in px and means nothing for type.
              TEXT_FONT_SIZES.map((s) => (
                <Pressable
                  key={s}
                  onPress={() => setFontSize(s)}
                  accessibilityRole="button"
                  accessibilityLabel={`Text size ${s}`}
                  accessibilityState={{ selected: fontSize === s }}
                  style={[
                    styles.sizeDot,
                    { borderColor: fontSize === s ? "#fff" : "transparent" },
                  ]}
                >
                  <Text
                    style={{
                      color,
                      fontFamily: "Inter_600SemiBold",
                      fontSize: 10 + TEXT_FONT_SIZES.indexOf(s) * 2,
                    }}
                  >
                    A
                  </Text>
                </Pressable>
              ))
            : SIZES.map((s) => (
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
  textDraftInput: {
    position: "absolute",
    // Match the committed SVG text: weight 600, top-anchored glyphs. No
    // padding/border offsets — the glyph box's top-left IS the tap point.
    padding: 0,
    margin: 0,
    borderWidth: 0,
    fontWeight: "600",
    backgroundColor: "rgba(0,0,0,0.25)",
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
