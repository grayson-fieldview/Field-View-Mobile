import { StyleSheet } from "react-native";

export const BRAND_ORANGE = "#f09004";

/** Layout + typography shared by the (auth) screens. */
export const authScreenStyles = StyleSheet.create({
  page: {
    paddingHorizontal: 16,
    flexGrow: 1,
  },
  // Fills the space above the pinned privacy footer and centers the
  // form within it (the centering `page` used to do directly).
  content: {
    flexGrow: 1,
    justifyContent: "center",
  },
  title: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.6,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    marginTop: 6,
    marginBottom: 18,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    // 14 matches components/Input.tsx so auth inputs and the shared
    // Input render at the same height.
    paddingVertical: 14,
  },
  inputText: { fontSize: 15, fontFamily: "Inter_500Medium" },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginVertical: 16,
  },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth },
  dividerText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  footerText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    marginTop: 16,
  },
});
