import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { BRAND_ORANGE } from "@/components/auth/authScreenStyles";
import { useColors } from "@/hooks/useColors";

export interface PillOption {
  value: string;
  label: string;
}

/**
 * Multi-row single-select pill/chip group for the onboarding screens.
 * Tapping the selected pill again deselects it (all onboarding pill
 * fields are optional — deselect IS the skip).
 *
 * Selected treatment: brand-orange border + light orange fill
 * (BRAND_ORANGE at ~10% alpha) + semibold orange label. Unselected:
 * white (colors.card) fill with colors.border.
 */
export function PillSelect({
  options,
  selected,
  onSelect,
}: {
  options: PillOption[];
  selected: string | null;
  onSelect: (value: string | null) => void;
}) {
  const colors = useColors();
  return (
    <View style={styles.wrap}>
      {options.map((opt) => {
        const active = opt.value === selected;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onSelect(active ? null : opt.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={opt.label}
            style={[
              styles.pill,
              active
                ? { borderColor: BRAND_ORANGE, backgroundColor: "#f090041A" }
                : { borderColor: colors.border, backgroundColor: colors.card },
            ]}
          >
            <Text
              style={[
                styles.pillText,
                active
                  ? { color: "#b56c00", fontFamily: "Inter_600SemiBold" }
                  : { color: colors.foreground },
              ]}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  pill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  pillText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
});
