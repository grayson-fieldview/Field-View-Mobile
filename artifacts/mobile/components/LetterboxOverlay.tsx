import React from "react";
import { StyleSheet, View } from "react-native";

import type { PhotoAspectRatio } from "@/services/imageProcessing";

/**
 * Black-bar overlay that masks the camera preview down to the user's
 * configured capture aspect ratio (B11). Same UX as CompanyCam — the
 * user only sees what the saved photo will actually contain, so the
 * frame matches reality and they don't lose top/bottom or left/right
 * of what they thought they captured.
 *
 * --- Reference frame ---
 *
 * The bars are positioned relative to a 3:4 PORTRAIT REFERENCE FRAME
 * (centered, width-fitted to the screen, aspectRatio 3/4). This
 * matches the iOS/Android native sensor shape in portrait: the
 * camera captures a 4:3-shaped frame which presents as 3:4 portrait
 * when held vertically. The reference frame is what the user
 * perceives as "the camera's view"; bars masking outside or inside
 * it are what they perceive as "stuff that won't be saved".
 *
 * Layout primitive: a flex column with three children — top spacer
 * (flex: 1, opaque black), the reference frame (width 100%,
 * aspectRatio 3/4), and bottom spacer (flex: 1, opaque black). On
 * tall phones the spacers absorb all vertical slack outside the
 * centered 3:4 box. No measurement needed.
 *
 * Inside the reference frame, additional masks per target ratio:
 *   "4:3"  → 3:4 portrait (same shape as reference) → no inner bars
 *   "1:1"  → square → top + bottom bars (12.5% of reference height
 *            each, derived from 3:4 → 1:1 vertical excess)
 *   "16:9" → 9:16 portrait → left + right bars (12.5% of reference
 *            width each, derived from 3:4 → 9:16 horizontal excess)
 *
 * --- Empirical alignment caveat ---
 *
 * This assumes the underlying CameraView in `absoluteFill` mode
 * presents the 4:3 sensor as 3:4 portrait centered with native
 * aspect-fit, so the visible preview content matches the 3:4
 * reference frame this overlay draws. If on-device QA on Build 11
 * shows misalignment between the overlay and the actual visible
 * preview, two fallback paths (in order of preference):
 *
 *   Option A (cleanest): add `aspectRatio: 3 / 4` to the CameraView
 *     style in capture.tsx so the camera view itself is constrained
 *     to the sensor shape. The overlay's reference frame will then
 *     exactly match the camera bounds.
 *
 *   Option B: measure the actual preview rect at runtime via
 *     onLayout/onCameraReady and plumb the measured rect into this
 *     overlay as a prop, computing bar offsets from real pixels
 *     rather than the assumed 3:4 reference. More work, only needed
 *     if Option A breaks the existing UI layout.
 *
 * --- Implementation notes ---
 *
 * Pure View+style — no animation, no measurement, no native deps.
 * `pointerEvents="none"` so the overlay never intercepts touches
 * meant for the shutter, zoom, etc.
 */
export function LetterboxOverlay({ ratio }: { ratio: PhotoAspectRatio }) {
  return (
    <View
      style={styles.root}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {/* Top outer bar: absorbs vertical slack above the centered
       * 3:4 reference frame. Solid black on tall phones; height
       * collapses to 0 on screens whose aspect equals or exceeds
       * 3:4 in width-relative-to-height (e.g. iPad portrait). */}
      <View style={styles.outerBar} />

      {/* Reference frame: width-fitted to screen, height derived
       * from aspectRatio. Contains optional inner masking bars. */}
      <View style={styles.referenceFrame}>
        <InnerMask ratio={ratio} />
      </View>

      {/* Bottom outer bar: mirror of top. */}
      <View style={styles.outerBar} />
    </View>
  );
}

/**
 * Drawn INSIDE the 3:4 reference frame. Adds top+bottom bars for
 * square crop or left+right bars for 9:16 crop. 3:4 (matches the
 * reference itself) renders nothing.
 *
 * Bar sizes are derived from the geometric difference between the
 * reference's 3:4 shape and the target shape.
 *
 *   Square: reference is 3w × 4h units; square crop is 3w × 3h
 *     centered → vertical excess 1h, half each end = 0.5h. As a
 *     fraction of reference height (4h): 0.5/4 = 12.5%.
 *
 *   9:16: reference is 3w × 4h; 9:16 portrait is (9/16 × 4h) ×
 *     4h = 2.25w × 4h centered → horizontal excess 0.75w, half
 *     each side = 0.375w. As a fraction of reference width (3w):
 *     0.375/3 = 12.5%.
 *
 * The 12.5% match for both shapes is coincidence, not a typo.
 */
function InnerMask({ ratio }: { ratio: PhotoAspectRatio }) {
  if (ratio === "4:3") return null;

  if (ratio === "1:1") {
    return (
      <>
        <View style={[innerStyles.barH, { top: 0 }]} />
        <View style={[innerStyles.barH, { bottom: 0 }]} />
      </>
    );
  }

  // ratio === "16:9" → 9:16 portrait
  return (
    <>
      <View style={[innerStyles.barV, { left: 0 }]} />
      <View style={[innerStyles.barV, { right: 0 }]} />
    </>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: "column",
    alignItems: "stretch",
  },
  outerBar: {
    flex: 1,
    backgroundColor: "#000",
  },
  referenceFrame: {
    width: "100%",
    aspectRatio: 3 / 4,
    // Background transparent — the camera shows through this region.
  },
});

const innerStyles = StyleSheet.create({
  barH: {
    position: "absolute",
    left: 0,
    right: 0,
    height: "12.5%",
    backgroundColor: "#000",
  },
  barV: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: "12.5%",
    backgroundColor: "#000",
  },
});
