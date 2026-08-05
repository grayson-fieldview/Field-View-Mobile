import { Image } from "expo-image";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { useColors } from "@/hooks/useColors";

const BRAND_ORANGE = "#f09004";

/**
 * Placeholder sources for the 3x2 photo grid. Replace the entries in
 * THIS array with real image sources (e.g. `require("...")` or
 * `{ uri: ... }`) to light up the grid — no other code changes needed.
 * A `null` source renders a solid muted tile.
 */
const GRID_TILES: { source: number | { uri: string } | null }[] = [
  { source: require("@/assets/images/welcome-1.jpg") },
  { source: require("@/assets/images/welcome-2.jpg") },
  { source: require("@/assets/images/welcome-3.jpg") },
  { source: require("@/assets/images/welcome-4.jpg") },
  { source: require("@/assets/images/welcome-5.jpg") },
  { source: require("@/assets/images/welcome-6.jpg") },
];

/**
 * Acquisition-facing landing screen shown to unauthenticated users on
 * cold launch (AuthGate routes here when no session is present).
 * "Get Started for Free" currently points at login — the OAuth
 * buttons there are the signup path until a dedicated signup screen
 * exists.
 */
export default function WelcomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [sheetVisible, setSheetVisible] = useState(false);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.muted }}
      contentContainerStyle={[
        styles.page,
        {
          paddingTop: insets.top + 16,
          paddingBottom: insets.bottom + 24,
        },
      ]}
    >
      {/* Replicates login.tsx's private BrandHeader (that file is sealed). */}
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

      <Text style={[styles.headline, { color: colors.foreground }]}>
        Every Job.{"\n"}Every Photo.{"\n"}One Place.
      </Text>
      <Text style={[styles.subhead, { color: colors.mutedForeground }]}>
        Jobsite documentation that holds up. Photos, tasks, and reports in
        one place.
      </Text>

      <View
        style={[
          styles.gridCard,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        <View style={styles.grid}>
          {GRID_TILES.map((tile, i) => (
            <View
              key={i}
              style={[styles.tile, { backgroundColor: colors.muted }]}
            >
              {tile.source ? (
                <Image
                  source={tile.source}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                />
              ) : null}
            </View>
          ))}
        </View>
      </View>

      <Button
        title="Get Started for Free"
        size="lg"
        onPress={() => router.push("/(auth)/login")}
        style={{ backgroundColor: BRAND_ORANGE, alignSelf: "stretch" }}
      />
      <Button
        title="Sign In"
        size="lg"
        variant="ghost"
        onPress={() => router.push("/(auth)/login")}
        style={{
          alignSelf: "stretch",
          marginTop: 10,
          borderWidth: 1,
          borderColor: colors.border,
        }}
      />

      <Pressable
        onPress={() => setSheetVisible(true)}
        hitSlop={8}
        style={styles.footerLinkWrap}
      >
        <Text style={[styles.footerLink, { color: colors.mutedForeground }]}>
          Joining a Team?
        </Text>
      </Pressable>

      {/* Informational bottom sheet — slide-up Modal with dim overlay
          (transparent-Modal pattern per ErrorFallback.tsx; the repo's
          AssigneePickerSheet is a pageSheet with no overlay, which
          can't satisfy tap-outside-to-dismiss). No invite entry, no
          API calls, no deep links. */}
      <Modal
        visible={sheetVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setSheetVisible(false)}
      >
        <Pressable
          style={styles.overlay}
          onPress={() => setSheetVisible(false)}
        >
          {/* Inner Pressable swallows taps so touching the sheet body
              doesn't dismiss. */}
          <Pressable
            style={[
              styles.sheet,
              {
                backgroundColor: colors.card,
                paddingBottom: insets.bottom + 20,
              },
            ]}
            onPress={() => {}}
          >
            <Text style={[styles.sheetTitle, { color: colors.foreground }]}>
              Joining a Team
            </Text>
            <Text
              style={[styles.sheetBody, { color: colors.mutedForeground }]}
            >
              You&apos;ll receive an invitation through text or email. Tap
              the link in that message to join your company.
            </Text>
            <Text
              style={[styles.sheetBody, { color: colors.mutedForeground }]}
            >
              Not finding your invite? Request one from your admin or
              manager.
            </Text>
            <Button
              title="Got It"
              size="lg"
              onPress={() => setSheetVisible(false)}
              style={{
                backgroundColor: BRAND_ORANGE,
                alignSelf: "stretch",
                marginTop: 18,
              }}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {
    paddingHorizontal: 16,
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  // brandRow/brandLogo/brandWord match login.tsx's BrandHeader styles.
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
  headline: {
    fontSize: 34,
    lineHeight: 40,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.8,
    textAlign: "center",
  },
  subhead: {
    fontSize: 15,
    lineHeight: 21,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    marginTop: 10,
    marginBottom: 20,
    maxWidth: 320,
  },
  gridCard: {
    alignSelf: "stretch",
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginBottom: 24,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 18,
    elevation: 3,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  tile: {
    // Three per row: (100% - 2 gaps of 8) / 3.
    width: "31.5%",
    flexGrow: 1,
    aspectRatio: 1,
    borderRadius: 10,
    overflow: "hidden",
  },
  footerLinkWrap: { marginTop: 18, alignItems: "center" },
  footerLink: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 24,
    paddingTop: 24,
  },
  sheetTitle: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.4,
    marginBottom: 12,
  },
  sheetBody: {
    fontSize: 15,
    lineHeight: 21,
    fontFamily: "Inter_400Regular",
    marginBottom: 10,
  },
});
