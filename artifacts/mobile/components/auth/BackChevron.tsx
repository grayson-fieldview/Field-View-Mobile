import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React from "react";
import { Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";

/** Absolute-positioned back chevron shared by the auth screens. */
export function BackChevron() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.back()}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel="Back"
      style={[styles.backChevron, { top: insets.top + 20 }]}
    >
      <Feather name="chevron-left" size={28} color={colors.foreground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // `top` is supplied inline as insets.top + 20: absolute children
  // position against the parent's border box, NOT its padding box,
  // so the scroll content's paddingTop never applied here and top: 0
  // sat the chevron under the notch. 44x44 meets Apple's HIG minimum
  // tap target.
  backChevron: {
    position: "absolute",
    left: 16,
    zIndex: 1,
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
