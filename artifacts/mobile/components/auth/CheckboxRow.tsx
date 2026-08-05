import { Feather } from "@expo/vector-icons";
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { BRAND_ORANGE } from "@/components/auth/authScreenStyles";
import { useColors } from "@/hooks/useColors";

/**
 * Checkbox + label row for the onboarding consent checkboxes. The
 * label is passed as children so callers can embed tappable link
 * Texts (Terms / Privacy) inside it — only the box itself toggles
 * when children contain their own pressables; the row's text area
 * also toggles via the outer Pressable for plain-text labels.
 */
export function CheckboxRow({
  checked,
  onToggle,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      style={styles.row}
      hitSlop={4}
    >
      <Feather
        name={checked ? "check-square" : "square"}
        size={20}
        color={checked ? BRAND_ORANGE : colors.mutedForeground}
        style={styles.box}
      />
      <View style={styles.labelWrap}>{children}</View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    minHeight: 44,
    marginTop: 14,
  },
  box: { marginTop: 1 },
  labelWrap: { flex: 1 },
});
