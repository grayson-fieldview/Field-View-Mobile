import { Feather } from "@expo/vector-icons";
import React from "react";

/**
 * Three-dot "more options" icon, centered correctly inside any
 * fixed-size circular button.
 *
 * `@expo/vector-icons` renders Feather glyphs through a React Native
 * `<Text>` element whose intrinsic line-height (~`size × 1.2`) is
 * larger than the rendered glyph. Flex centering centers the Text
 * box, not the optical center of the dots, so a bare
 * `<Feather name="more-horizontal" />` inside a flex-centered circle
 * sits ~1–2px above true center (more pronounced on Android due to
 * the default `includeFontPadding: true`).
 *
 * Collapsing `lineHeight` to `size` and disabling Android font
 * padding makes the Text cell exactly the glyph's height, so the
 * parent's `alignItems: "center"; justifyContent: "center"` lands
 * the dots on the geometric center of the container.
 *
 * Use this anywhere a kebab/more-options icon is rendered so all
 * instances stay visually consistent.
 */
export default function KebabIcon({
  size,
  color,
}: {
  size: number;
  color: string;
}) {
  return (
    <Feather
      name="more-horizontal"
      size={size}
      color={color}
      style={{ lineHeight: size, includeFontPadding: false }}
    />
  );
}
