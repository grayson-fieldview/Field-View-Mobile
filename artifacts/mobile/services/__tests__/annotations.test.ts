/**
 * Round-trip + conversion tests for services/annotations.ts.
 *
 * Runs with Node's built-in test runner and native type stripping —
 * no test framework installed:  `pnpm --filter @workspace/mobile test`
 * (i.e. `node --test "services/__tests__/*.test.ts"` on Node >= 22.18).
 *
 * Relative `.ts` imports are intentional: node runs these files directly,
 * without the app's `@/` alias or a bundler.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_STROKE_WIDTH,
  MIN_DRAG_PX,
  arrowHeadPath,
  hasMinDrag,
  isLegacyMobileStrokeId,
  rawToCanonical,
  strokeToRenderShape,
  toCanonicalForSave,
  toPixels,
  widthToPx,
} from "../annotations.ts";
import { newStrokeId } from "../id.ts";
import type { StoredStroke } from "../types.ts";
import { KNOWN_STROKE_TYPES, isKnownStrokeType } from "../types.ts";

const W = 400;
const H = 300;
const close = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

// ---------- Task 0: width unit heuristic (id-provenance ladder) ----------

// Legacy mobile base-36 id: Date.now().toString(36) + random suffix.
const legacyId = new Date("2026-01-15T12:00:00Z").getTime().toString(36) + "abc12345";
const webUuid = "a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const webFallbackId = `s-${Date.now()}-abc123`;

test("isLegacyMobileStrokeId: base-36 yes; UUID / hex-32 / s- / fv- no", () => {
  assert.ok(isLegacyMobileStrokeId(legacyId));
  // Leading char of Date.now().toString(36) is >= 'g' until 2059-05-25,
  // so even an all-hex random suffix classifies correctly.
  assert.ok(isLegacyMobileStrokeId(Date.now().toString(36) + "abcdef12"));
  assert.ok(!isLegacyMobileStrokeId(webUuid));
  assert.ok(!isLegacyMobileStrokeId(webUuid.replace(/-/g, ""))); // hex-32: no [g-z]
  assert.ok(!isLegacyMobileStrokeId(webFallbackId));
  assert.ok(!isLegacyMobileStrokeId(newStrokeId()));
  assert.ok(!isLegacyMobileStrokeId(undefined));
  assert.ok(!isLegacyMobileStrokeId(""));
  assert.ok(!isLegacyMobileStrokeId("a".repeat(21))); // > 20 chars
});

test("newStrokeId mints fv- + UUIDv4", () => {
  const id = newStrokeId();
  assert.match(id, /^fv-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(newStrokeId(), id);
});

test("widthToPx: bare base-36 id is 1000-units, ALWAYS — even integers", () => {
  // Legacy mobile: 5px pen on a 335px canvas → (5/335)*1000 = 14.9253...
  const legacy = (5 / 335) * 1000;
  close(widthToPx(legacy, 335, legacyId), 5);
  close(widthToPx(legacy, 670, legacyId), 10); // scales with the box
  // Even an integer-looking width is 1000-units for a legacy id.
  close(widthToPx(15, 400, legacyId), 6);
});

test("widthToPx: UUID / s- / fv- ids are raw px, even non-integers", () => {
  assert.equal(widthToPx(3, W, webUuid), 3);
  assert.equal(widthToPx(4.5, W, webUuid), 4.5);
  assert.equal(widthToPx(8, W, webFallbackId), 8);
  assert.equal(widthToPx(2.5, W, newStrokeId()), 2.5);
});

test("widthToPx: unrecognized id shape → px, with a warning", () => {
  const warnings: unknown[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warnings.push(a);
  try {
    assert.equal(widthToPx(3, W), 3); // missing id
    assert.equal(widthToPx(14.9, 335, webUuid.replace(/-/g, "")), 14.9); // hex-32
    assert.equal(widthToPx(4, W, webUuid), 4); // known shape: no warn
  } finally {
    console.warn = orig;
  }
  assert.equal(warnings.length, 2);
});

test("widthToPx: garbage falls back to default", () => {
  assert.equal(widthToPx(undefined, W), DEFAULT_STROKE_WIDTH);
  assert.equal(widthToPx(0, W), DEFAULT_STROKE_WIDTH);
  assert.equal(widthToPx(-2, W), DEFAULT_STROKE_WIDTH);
  assert.equal(widthToPx(Number.NaN, W), DEFAULT_STROKE_WIDTH);
});

// ---------- strokeToRenderShape: all six types ----------

test("pencil resolves normalized points to px", () => {
  // NB: render fixtures use fv- ids — a bare short id like "p1" contains
  // a [g-z] char and would classify as legacy 1000-units.
  const s: StoredStroke = {
    id: "fv-p1",
    type: "pencil",
    color: "#ff0000",
    width: 4,
    points: [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ],
  };
  const shape = strokeToRenderShape(s, W, H);
  assert.ok(shape && shape.kind === "pencil");
  assert.equal(shape.strokeWidth, 4);
  assert.deepEqual(shape.points[1], { x: 200, y: 150 });
});

test("line and arrow resolve [start,end]", () => {
  for (const type of ["line", "arrow"] as const) {
    const shape = strokeToRenderShape(
      { id: "fv-l1", type, width: 2, points: [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 1 }] },
      W,
      H,
    );
    assert.ok(shape && shape.kind === type);
    assert.equal(shape.x1, 100);
    assert.equal(shape.y1, 150);
    assert.equal(shape.x2, 300);
    assert.equal(shape.y2, 300);
  }
});

test("circle: points = [center, radiusPoint], r = px distance (web contract)", () => {
  const shape = strokeToRenderShape(
    {
      id: "fv-c1",
      type: "circle",
      width: 3,
      points: [
        { x: 0.5, y: 0.5 },
        { x: 0.75, y: 0.5 },
      ],
    },
    W,
    H,
  );
  assert.ok(shape && shape.kind === "circle");
  assert.equal(shape.cx, 200);
  assert.equal(shape.cy, 150);
  close(shape.r, 100); // 0.25 * 400px
});

test("rectangle normalizes corner order", () => {
  const shape = strokeToRenderShape(
    {
      id: "fv-r1",
      type: "rectangle",
      width: 3,
      points: [
        { x: 0.75, y: 1 },
        { x: 0.25, y: 0.5 },
      ],
    },
    W,
    H,
  );
  assert.ok(shape && shape.kind === "rectangle");
  assert.deepEqual(
    { x: shape.x, y: shape.y, w: shape.w, h: shape.h },
    { x: 100, y: 150, w: 200, h: 150 },
  );
});

test("text: top-level normalized x/y, raw px fontSize", () => {
  const shape = strokeToRenderShape(
    { id: "t1", type: "text", x: 0.1, y: 0.2, content: "hi", fontSize: 24 },
    W,
    H,
  );
  assert.ok(shape && shape.kind === "text");
  close(shape.x, 40);
  close(shape.y, 60);
  assert.equal(shape.fontSize, 24);
  assert.equal(shape.content, "hi");
});

test("unknown type renders as null (skipped, not crashed)", () => {
  assert.equal(
    strokeToRenderShape(
      { id: "u1", type: "sticker", points: [{ x: 0.1, y: 0.1 }] } as StoredStroke,
      W,
      H,
    ),
    null,
  );
});

test("degenerate strokes render as null", () => {
  assert.equal(strokeToRenderShape({ id: "d1", type: "line", points: [{ x: 0.1, y: 0.1 }] }, W, H), null);
  assert.equal(strokeToRenderShape({ id: "d2", type: "pencil", points: [] }, W, H), null);
  assert.equal(strokeToRenderShape({ id: "d3", type: "text", x: 0.1, y: 0.1, content: "" }, W, H), null);
  assert.equal(strokeToRenderShape({ id: "d4", type: "pencil", points: [{ x: 0.5, y: 0.5 }] }, 0, 0), null);
});

// ---------- round-trip: canonical → px → canonical ----------

test("round-trip: canonical → render px → re-normalized equals original", () => {
  const canonical: StoredStroke = {
    id: "rt1",
    type: "pencil",
    width: 3,
    color: "#3b82f6",
    points: [
      { x: 0.125, y: 0.25 },
      { x: 0.5, y: 0.75 },
      { x: 0.875, y: 0.1 },
    ],
  };
  const shape = strokeToRenderShape(canonical, W, H);
  assert.ok(shape && shape.kind === "pencil");
  const back = shape.points.map((p) => ({ x: p.x / W, y: p.y / H }));
  back.forEach((p, i) => {
    close(p.x, canonical.points![i].x);
    close(p.y, canonical.points![i].y);
  });
  // Save path must not mutate the values either.
  const saved = toCanonicalForSave(canonical) as StoredStroke;
  assert.deepEqual(saved.points, canonical.points);
  assert.equal(saved.width, 3); // verbatim, not re-united
  assert.equal(saved.id, "rt1"); // id preserved, never regenerated
});

test("round-trip via legacy toPixels path stays consistent", () => {
  const canonical: StoredStroke = {
    id: legacyId, // legacy mobile-minted id
    type: "pencil",
    width: (5 / 335) * 1000, // legacy non-integer width
    points: [
      { x: 0.2, y: 0.4 },
      { x: 0.6, y: 0.8 },
    ],
  };
  const px = toPixels(canonical, 335, 335);
  close(px.size ?? 0, 5); // heuristic: non-integer → 1000-units
  const saved = toCanonicalForSave(canonical) as StoredStroke;
  close(saved.width as number, (5 / 335) * 1000); // stored width untouched
});

// ---------- toCanonicalForSave ----------

test("unknown stroke types pass through save unchanged", () => {
  const foreign = {
    id: "f1",
    type: "polygon",
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.9 },
    ],
    width: 7,
    color: "#000",
    extraFutureField: { nested: true },
  } as unknown as StoredStroke;
  const saved = toCanonicalForSave(foreign);
  assert.deepEqual(saved, foreign);
});

test("unknown stroke without id gets one minted (Zod wire requirement)", () => {
  const saved = toCanonicalForSave({ type: "polygon" } as StoredStroke);
  assert.equal(typeof saved.id, "string");
  assert.ok(saved.id.length > 0);
});

test("text strokes are preserved untouched on save", () => {
  const t: StoredStroke = {
    id: "t2",
    type: "text",
    x: 0.3,
    y: 0.4,
    content: "note",
    color: "#fff",
    fontSize: 18,
  };
  assert.deepEqual(toCanonicalForSave(t), t);
});

test("legacy raw-px stroke normalizes and writes integer px width", () => {
  const legacy: StoredStroke = {
    id: "lg1",
    points: [
      { x: 100, y: 100 },
      { x: 200, y: 300 },
    ],
    size: 6,
    canvasW: 400,
    canvasH: 400,
    color: "#111",
  };
  const saved = toCanonicalForSave(legacy);
  assert.equal(saved.type, "pencil");
  assert.equal(saved.width, 6); // raw px preserved as integer px
  close(saved.points![0].x, 0.25);
  close(saved.points![1].y, 0.75);
});

test("id-less 1000-unit stroke is normalized to px + fv- id on save", () => {
  // Post-5f1409c / pre-22a8844 window: no id, no size/canvasW, width in
  // 1000-units. 14.925... on a 335px box = the legacy 5px pen.
  const saved = toCanonicalForSave(
    {
      type: "pencil",
      width: (5 / 335) * 1000, // 14.9253...
      color: "#111",
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.9 },
      ],
    } as StoredStroke,
    335,
  ) as StoredStroke;
  assert.equal(saved.width, 5); // normalized px, BEFORE the id was minted
  assert.ok((saved.id as string).startsWith("fv-"));
  // And the new id now honestly describes the width as px on read:
  assert.equal(widthToPx(saved.width as number, 335, saved.id), 5);
});

test("id-less Gen-1 stroke (size/canvasW) is untouched by the normalizer", () => {
  // canvasMeta runs FIRST: size is authoritative px, not 1000-units.
  const saved = toCanonicalForSave(
    {
      points: [{ x: 100, y: 100 }, { x: 200, y: 200 }],
      size: 6,
      canvasW: 400,
      canvasH: 400,
    } as StoredStroke,
    335,
  ) as StoredStroke;
  assert.equal(saved.width, 6);
});

test("text save clamps x/y to 0..1 and fontSize to 8..96", () => {
  const saved = toCanonicalForSave({
    id: "fv-t3",
    type: "text",
    x: 1.2,
    y: -0.1,
    content: "hi",
    color: "#fff",
    fontSize: 200,
  });
  assert.ok(saved.type === "text");
  assert.equal(saved.x, 1);
  assert.equal(saved.y, 0);
  assert.equal(saved.fontSize, 96);
  assert.equal(
    (toCanonicalForSave({ id: "fv-t4", type: "text", x: 0.5, y: 0.5, content: "a", fontSize: 4 }) as { fontSize?: number }).fontSize,
    8,
  );
});

// ---------- degenerate-shape guard ----------

test("hasMinDrag: taps and micro-drags rejected, real drags accepted", () => {
  assert.ok(!hasMinDrag([]));
  assert.ok(!hasMinDrag([{ x: 10, y: 10 }])); // tap
  assert.ok(!hasMinDrag([{ x: 10, y: 10 }, { x: 12, y: 11 }])); // jitter
  assert.ok(hasMinDrag([{ x: 10, y: 10 }, { x: 10 + MIN_DRAG_PX, y: 10 }]));
  // Distance measured from the ORIGIN, so a long path that returns near
  // its start still counts (it crossed the threshold mid-path).
  assert.ok(hasMinDrag([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 1, y: 1 }]));
});

// ---------- rawToCanonical (new authoring path) ----------

test("rawToCanonical writes integer px width and stamps the given type", () => {
  const raw = {
    color: "#ef4444",
    size: 6,
    canvasW: 335,
    canvasH: 500,
    points: [
      { x: 0, y: 0 },
      { x: 335, y: 250 },
    ],
  };
  const c = rawToCanonical(raw, "pencil");
  assert.equal(c.type, "pencil");
  assert.equal(c.width, 6); // px int — NOT (6/335)*1000
  assert.equal(typeof c.id, "string");
  close(c.points![1].x, 1);
  close(c.points![1].y, 0.5);
  // Type comes from the caller (activeTool), not a hardcoded constant.
  assert.equal(rawToCanonical(raw, "line").type, "line");
});

// ---------- arrowhead + type guards ----------

test("arrowHeadPath: head length max(12, width*4), two barbs", () => {
  // Horizontal arrow pointing +x; barbs go back-left at ±30°.
  const d = arrowHeadPath(0, 0, 100, 0, 3);
  const segs = d.split("M").filter(Boolean);
  assert.equal(segs.length, 2);
  assert.ok(d.startsWith("M100.0 0.0"));
  // len = max(12, 12) = 12 → barb x = 100 - 12*cos(30°) ≈ 89.6
  assert.ok(d.includes("89.6"));
});

test("isKnownStrokeType covers exactly the six wire types", () => {
  assert.equal(KNOWN_STROKE_TYPES.length, 6);
  for (const t of KNOWN_STROKE_TYPES) assert.ok(isKnownStrokeType(t));
  assert.ok(!isKnownStrokeType("sticker"));
  assert.ok(!isKnownStrokeType(undefined));
});
