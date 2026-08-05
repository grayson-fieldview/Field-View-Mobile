import React from "react";
import { StyleSheet, Text } from "react-native";

import { useColors } from "@/hooks/useColors";

export function FieldLabel({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: object;
}) {
  const colors = useColors();
  return (
    <Text style={[styles.label, { color: colors.foreground }, style]}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 6,
  },
});
