import { Image } from "expo-image";
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";

export function BrandHeader() {
  const colors = useColors();
  return (
    <View style={styles.brandRow}>
      <Image
        source={require("@/assets/images/icon.png")}
        style={styles.brandLogo}
        contentFit="contain"
      />
      <Text style={[styles.brandWord, { color: colors.foreground }]}>
        Field View
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    marginBottom: 16,
  },
  brandLogo: { width: 32, height: 32, borderRadius: 7 },
  brandWord: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.4,
  },
});
