import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Svg, {
  Circle,
  G,
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
  fittedContainRect,
  hasMinDrag,
  hitTestStrokesPx,
  rawToCanonical,
  shapeBoundsPx,
  strokeToRenderShape,
  textToCanonical,
  translateStroke,
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
export function renderShape(shape: RenderShape, key: string | number) {
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
      // ONE anchoring rule, all surfaces, both platforms — mirrored from
      // the web repo: explicit arithmetic offset, NO dominant-baseline /
      // alignmentBaseline (their support differs across Safari,
      // react-native-svg on Android, and the server-side PDF-flatten
      // renderer; arithmetic behaves identically everywhere).
      // shape.fontSize arrives RESOLVED from strokeToRenderShape
      // (fontSizeNorm scheme — identity at the authoring basis for
      // norm-bearing strokes).
      const y = shape.y + shape.fontSize * 0.8;
      // Contrast halo: react-native-svg does not honor paintOrder
      // reliably, so render twice at identical coordinates — stroke-only
      // underneath, fill-only on top.
      return (
        <React.Fragment key={key}>
          <SvgText
            x={shape.x}
            y={y}
            fill="none"
            stroke="rgba(0,0,0,0.9)"
            strokeWidth={shape.fontSize / 8}
            strokeLinejoin="round"
            strokeLinecap="round"
            fontSize={shape.fontSize}
            fontWeight="600"
          >
            {shape.content}
          </SvgText>
          <SvgText
            x={shape.x}
            y={y}
            fill={shape.color}
            fontSize={shape.fontSize}
            fontWeight="600"
          >
            {shape.content}
          </SvgText>
        </React.Fragment>
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
/** Toolbar entries: the five drawing tools plus select (not a stroke type). */
type EditorTool = KnownStrokeType | "select";

const TOOLS: {
  key: EditorTool;
  label: string;
  icon: React.ComponentProps<typeof Feather>["name"];
}[] = [
  { key: "pencil", label: "Pencil", icon: "edit-2" },
  { key: "arrow", label: "Arrow", icon: "arrow-up-right" },
  { key: "circle", label: "Circle", icon: "circle" },
  { key: "rectangle", label: "Rectangle", icon: "square" },
  { key: "text", label: "Text", icon: "type" },
  { key: "select", label: "Select", icon: "mouse-pointer" },
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
  onUpdateStroke,
  onDeleteStroke,
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
  /** Replace an OWN stroke (matched by id) after a move. */
  onUpdateStroke: (stroke: CanonicalStroke) => void;
  /** Delete an OWN stroke by id (own row minus that stroke). */
  onDeleteStroke: (id: string) => void;
  onClear: () => void;
  onDone: () => void;
  /** Absolute top (px) for the edit tool rows, below the parent's row 1. */
  panelTop: number;
}) {
  // Active authoring tool. Commit reads the type from here instead of
  // hardcoding "pencil" — Phase 2 tools plug in without touching commit.
  const [activeTool, setActiveTool] = useState<EditorTool>("pencil");

  // ----- Selection (select tool) -----
  // Only OWN strokes are selectable — others' rows aren't ours to write.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // In-flight drag: rect-space px. bounds = selected shape's bbox at drag
  // start, used to clamp the delta so the stroke stays inside the fitted
  // rect. Ref (not state) — read/written synchronously by the responder.
  const dragRef = useRef<{
    startX: number;
    startY: number;
    bounds: { minX: number; minY: number; maxX: number; maxY: number };
  } | null>(null);
  // Live drag delta in px — state so the selected-stroke overlay re-renders.
  const [dragDelta, setDragDelta] = useState<{ dx: number; dy: number }>({
    dx: 0,
    dy: 0,
  });

  const selectedStroke = useMemo(
    () => ownStrokes.find((s) => s.id === selectedId) ?? null,
    [ownStrokes, selectedId],
  );
  // Selection can go stale under it (undo popped it, clear-all, server
  // reseed) — drop it instead of showing a ghost.
  useEffect(() => {
    if (selectedId && !selectedStroke) {
      setSelectedId(null);
      dragRef.current = null;
      setDragDelta({ dx: 0, dy: 0 });
    }
  }, [selectedId, selectedStroke]);
  // Leaving the select tool deselects.
  useEffect(() => {
    if (activeTool !== "select" && selectedId) {
      setSelectedId(null);
      dragRef.current = null;
      setDragDelta({ dx: 0, dy: 0 });
    }
  }, [activeTool, selectedId]);

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
    // Anchor is container-space (the input is container-anchored);
    // re-base to the fitted image rect — the web's coordinate basis.
    const rect = fitRectRef.current;
    if (!rect) return; // no basis → nothing can be committed correctly
    const stroke = textToCanonical({
      xPx: anchor.x - rect.x,
      yPx: anchor.y - rect.y,
      content: textDraft,
      color,
      fontSize,
      canvasW: rect.w,
      canvasH: rect.h,
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

  // Captured container box (the absoluteFill View). NOT the coordinate
  // basis — that's fitRect below. Kept as a ref (read synchronously at
  // draw time) AND mirrored to state so the render recomputes fitRect on
  // layout changes (rotation, split view).
  const canvasSize = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const [editBox, setEditBox] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });
  // Intrinsic pixel size of the photo, from expo-image's onLoad. Arrives
  // async (after first layout for remote URIs); until it does, fitRect is
  // null and the editor renders NO committed strokes and accepts NO
  // touches — never draw or normalize against the container basis.
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(
    null,
  );
  useEffect(() => setImgSize(null), [photoUri]);

  // THE coordinate basis: the rect the contain-fitted image occupies
  // inside the container. Matches the web editor, which normalizes
  // against the fitted image rect — 0..1 must mean "fraction of the
  // photo", not "fraction of the container incl. letterbox bars".
  const fitRect = useMemo(
    () =>
      fittedContainRect(
        editBox.w,
        editBox.h,
        imgSize?.w ?? 0,
        imgSize?.h ?? 0,
      ),
    [editBox, imgSize],
  );
  // Ref mirror for the synchronous gesture handlers.
  const fitRectRef = useRef(fitRect);
  fitRectRef.current = fitRect;

  // Basis changed mid-gesture (rotation, split-view resize, intrinsic
  // size re-report): DISCARD the in-progress stroke. Its points are
  // container-space against the OLD rect; committing them against the
  // new rect would store wrong coordinates.
  useEffect(() => {
    if (currentStroke.current) {
      currentStroke.current = null;
      force((n) => n + 1);
    }
    // An in-flight selection DRAG has the same problem: its start point
    // and clamp bounds are px against the old rect. Keep the selection
    // (it's normalized), drop the drag.
    if (dragRef.current) {
      dragRef.current = null;
      setDragDelta({ dx: 0, dy: 0 });
    }
  }, [fitRect]);

  // Clamp a container-space touch point into the fitted image rect —
  // letterbox-bar touches snap to the nearest image edge instead of
  // recording as valid coordinates outside the photo.
  const clampToRect = (
    x: number,
    y: number,
    r: { x: number; y: number; w: number; h: number },
  ) => ({
    x: Math.min(Math.max(x, r.x), r.x + r.w),
    y: Math.min(Math.max(y, r.y), r.y + r.h),
  });

  const startStroke = (rawX: number, rawY: number) => {
    // No basis yet (intrinsic size hasn't loaded) → accept nothing.
    // A stroke normalized against the container would be stored in the
    // wrong basis forever.
    const rect = fitRectRef.current;
    if (!rect) return;
    const { x, y } = clampToRect(rawX, rawY, rect);
    if (activeTool === "select") {
      // Hit-test in RECT-SPACE px (container point minus rect origin) —
      // strokes are stored normalized against the fitted rect, never the
      // container. Only own strokes are candidates.
      const hit = hitTestStrokesPx(
        ownStrokes,
        x - rect.x,
        y - rect.y,
        rect.w,
        rect.h,
      );
      setSelectedId(hit);
      setDragDelta({ dx: 0, dy: 0 });
      if (hit) {
        const s = ownStrokes.find((st) => st.id === hit);
        const shape = s ? strokeToRenderShape(s, rect.w, rect.h) : null;
        dragRef.current = shape
          ? { startX: x, startY: y, bounds: shapeBoundsPx(shape) }
          : null;
      } else {
        dragRef.current = null; // tap on empty space = deselect
      }
      return;
    }
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
      // Live points stay in CONTAINER space (the preview SVG is
      // container-anchored); they're re-based to the fitted rect at
      // commit time in endStroke.
      points: [{ x, y }],
      canvasW: rect.w || undefined,
      canvasH: rect.h || undefined,
    };
    force((n) => n + 1);
  };
  const extendStroke = (rawX: number, rawY: number) => {
    const rect = fitRectRef.current;
    if (!rect) return;
    if (activeTool === "select") {
      const drag = dragRef.current;
      if (!drag || !selectedId) return;
      // Clamp the delta so the stroke's bbox stays inside the fitted
      // rect — a stroke can be dragged flush against an edge but never
      // out of the image.
      const b = drag.bounds;
      const dx = Math.max(
        -b.minX,
        Math.min(rawX - drag.startX, rect.w - b.maxX),
      );
      const dy = Math.max(
        -b.minY,
        Math.min(rawY - drag.startY, rect.h - b.maxY),
      );
      setDragDelta({ dx, dy });
      return;
    }
    const s = currentStroke.current;
    if (!s) return;
    const { x, y } = clampToRect(rawX, rawY, rect);
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
    if (activeTool === "select") {
      const rect = fitRectRef.current;
      const drag = dragRef.current;
      dragRef.current = null;
      const { dx, dy } = dragDelta;
      setDragDelta({ dx: 0, dy: 0 });
      if (!rect || !drag || !selectedStroke) return;
      if (dx === 0 && dy === 0) return; // plain tap — selection only
      // Commit the move: px delta -> NORMALIZED delta against the fitted
      // rect (the storage basis). translateStroke canonicalizes legacy
      // strokes and preserves the id.
      onUpdateStroke(translateStroke(selectedStroke, dx / rect.w, dy / rect.h));
      return;
    }
    const s = currentStroke.current;
    const rect = fitRectRef.current;
    currentStroke.current = null;
    // Discard taps / sub-threshold drags: the server has no min-length on
    // `points`, so a zero-length arrow/circle would validate and sync.
    // A vanished rect mid-gesture (photo swapped) also discards.
    if (!s || !rect || !hasMinDrag(s.points)) {
      force((n) => n + 1);
      return;
    }
    // Convert the freshly-drawn raw px stroke to canonical 0..1 at the
    // edge; the type comes from the TOOL SNAPSHOT taken at gesture start.
    // Shape strokes are hardened to exactly [start, end] here — the
    // accumulation rule already maintains that, but a malformed live
    // buffer must never reach the wire with extra points.
    //
    // BASIS: points are re-based from container space to the fitted
    // image rect (subtract the letterbox origin) and normalized against
    // the RECT's size — the web editor's basis. Never normalize against
    // the container (pre-build-42 bug: strokes stored in a
    // container-relative basis never lined up on any other client).
    const tool = strokeTool.current;
    const containerPts =
      tool === "pencil" ? s.points : [s.points[0], s.points[s.points.length - 1]];
    const points = containerPts.map((p) => ({
      x: p.x - rect.x,
      y: p.y - rect.y,
    }));
    onCommit(
      rawToCanonical(
        {
          ...s,
          points,
          canvasW: rect.w || undefined,
          canvasH: rect.h || undefined,
        },
        tool,
      ),
    );
  };

  // Committed strokes render through the memoized AnnotationLayer; the
  // per-move force() re-render only re-draws the live path below it.
  // The SELECTED stroke is excluded — it renders in the selection
  // overlay instead (highlighted, translated by the live drag delta).
  const committed = useMemo(
    () =>
      [...othersStrokes, ...ownStrokes].filter((s) => s.id !== selectedId),
    [othersStrokes, ownStrokes, selectedId],
  );
  const live = currentStroke.current;

  // Selection overlay geometry: resolved at the fitted-rect size (the
  // storage basis), rendered inside the rect-positioned wrapper below.
  const selectedShape = useMemo(
    () =>
      selectedStroke && fitRect
        ? strokeToRenderShape(selectedStroke, fitRect.w, fitRect.h)
        : null,
    [selectedStroke, fitRect],
  );
  const selectedBounds = useMemo(
    () => (selectedShape ? shapeBoundsPx(selectedShape) : null),
    [selectedShape],
  );

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
          onLoad={(e) => {
            // Intrinsic pixel size — the other half of the fitRect
            // basis. Until this fires, fitRect is null and no strokes
            // render / no touches register.
            const w = e.source?.width;
            const h = e.source?.height;
            if (w && h) {
              setImgSize((prev) =>
                prev && prev.w === w && prev.h === h ? prev : { w, h },
              );
            }
          }}
        />
        {/* Committed strokes denormalize against the FITTED IMAGE RECT
            (web parity), so the layer is positioned at the rect, not
            stretched over the container. Nothing renders until the rect
            is known — a frame with no annotations beats a frame with
            annotations in the wrong place. */}
        {fitRect ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: fitRect.x,
              top: fitRect.y,
              width: fitRect.w,
              height: fitRect.h,
            }}
          >
            <AnnotationLayer
              strokes={committed}
              width={fitRect.w}
              height={fitRect.h}
            />
            {/* Selection overlay: the selected stroke re-rendered on top,
                translated by the live drag delta, with a dashed bbox
                highlight. Rect-space px throughout. */}
            {selectedShape && selectedBounds ? (
              <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
                <G translateX={dragDelta.dx} translateY={dragDelta.dy}>
                  {renderShape(selectedShape, "selected")}
                  <Rect
                    x={selectedBounds.minX - 6}
                    y={selectedBounds.minY - 6}
                    width={selectedBounds.maxX - selectedBounds.minX + 12}
                    height={selectedBounds.maxY - selectedBounds.minY + 12}
                    stroke="#fff"
                    strokeWidth={1.5}
                    strokeDasharray="6 4"
                    fill="rgba(255,255,255,0.08)"
                  />
                </G>
              </Svg>
            ) : null}
          </View>
        ) : null}
        {live && live.points.length > 0 ? (
          <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
            <LivePreview stroke={live} tool={strokeTool.current} />
          </Svg>
        ) : null}
        {pendingText ? (
          // WYSIWYG placement: the input's own glyphs sit at the tap
          // point (top-left), styled exactly like the committed SVG text
          // (raw fontSize px — the committed render uses raw px in the
          // same fitted-rect basis, so this is WYSIWYG — weight 600,
          // active color).
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
          {selectedId ? (
            // Delete the SELECTED stroke only — own row minus this one;
            // the existing save path (PUT) carries it on flush.
            <Pressable
              onPress={() => {
                const id = selectedId;
                setSelectedId(null);
                dragRef.current = null;
                setDragDelta({ dx: 0, dy: 0 });
                onDeleteStroke(id);
              }}
              accessibilityRole="button"
              accessibilityLabel="Delete selected annotation"
              style={styles.clearBtn}
            >
              <Text style={styles.clearTxt}>Delete</Text>
            </Pressable>
          ) : null}
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
