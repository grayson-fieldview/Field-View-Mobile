import { Feather } from "@expo/vector-icons";
import React from "react";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";

/**
 * Settings-style list row. Promoted from app/(tabs)/profile.tsx so both
 * the profile and settings screens can share it.
 *
 * Right-side affordance precedence:
 *   onValueChange present  → render <Switch> (boolean value)
 *   onPress present        → render chevron-right (string value ignored)
 *   neither                → render value as plain text
 */
export function Row({
  icon,
  label,
  subtitle,
  value,
  onPress,
  onValueChange,
  destructive,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  /** Optional secondary line rendered under the label. */
  subtitle?: string;
  value?: string | boolean;
  onPress?: () => void;
  onValueChange?: (next: boolean) => void;
  /** Tints the icon + label with the destructive color. */
  destructive?: boolean;
}) {
  const colors = useColors();
  const isSwitch = onValueChange !== undefined;
  const tint = destructive ? colors.destructive : colors.foreground;
  const iconTint = destructive ? colors.destructive : colors.mutedForeground;
  const body = (
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      <View style={styles.rowLeft}>
        <Feather name={icon} size={18} color={iconTint} />
        <View style={styles.rowLabels}>
          <Text style={[styles.rowLabel, { color: tint }]}>{label}</Text>
          {subtitle ? (
            <Text
              style={[styles.rowSubtitle, { color: colors.mutedForeground }]}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      {isSwitch ? (
        <Switch
          value={typeof value === "boolean" ? value : false}
          onValueChange={onValueChange}
          trackColor={{ true: colors.primary, false: colors.muted }}
          accessibilityLabel={label}
        />
      ) : onPress ? (
        <Feather
          name="chevron-right"
          size={18}
          color={colors.mutedForeground}
        />
      ) : (
        <Text style={[styles.rowValue, { color: colors.mutedForeground }]}>
          {typeof value === "string" ? value : ""}
        </Text>
      )}
    </View>
  );
  // Switch rows must NOT be wrapped in a Pressable — tapping the row
  // body would race the Switch's own gesture handler.
  if (onPress && !isSwitch) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="link"
        accessibilityLabel={label}
      >
        {body}
      </Pressable>
    );
  }
  return body;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLeft: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  rowLabels: { flexShrink: 1, gap: 2 },
  rowLabel: { fontSize: 15, fontFamily: "Inter_500Medium" },
  rowSubtitle: { fontSize: 12, fontFamily: "Inter_400Regular" },
  rowValue: { fontSize: 14, fontFamily: "Inter_400Regular" },
});
