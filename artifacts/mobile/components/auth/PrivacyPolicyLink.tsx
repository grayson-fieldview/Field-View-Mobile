import * as Linking from "expo-linking";
import React from "react";
import { StyleSheet, Text } from "react-native";

import { useColors } from "@/hooks/useColors";

/**
 * Pinned legal footer shared by the auth screens. Render it as the
 * last sibling of the flexGrow'd content block — it hugs the bottom
 * of the viewport on tall screens and simply follows the content
 * (scrollable, never overlapping) on short ones.
 */
export function PrivacyPolicyLink() {
  const colors = useColors();
  return (
    <Text
      style={[styles.privacyLink, { color: colors.mutedForeground }]}
      onPress={() => {
        void Linking.openURL(
          "https://www.field-view.com/legal/privacy-policy",
        );
      }}
    >
      Privacy Policy
    </Text>
  );
}

const styles = StyleSheet.create({
  // Legal footer: smaller/more muted than the cross-link above so it
  // reads as legal boilerplate, not navigation.
  privacyLink: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    textDecorationLine: "underline",
    opacity: 0.8,
    marginTop: 28,
  },
});
