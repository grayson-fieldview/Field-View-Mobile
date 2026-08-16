import { Feather } from "@expo/vector-icons";
import { reloadAppAsync } from "expo";
import * as Clipboard from "expo-clipboard";
import React, { useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { formatBuildInfo, getBuildInfo } from "@/lib/buildInfo";

export type ErrorFallbackProps = {
  error: Error;
  resetError: () => void;
};

export function ErrorFallback({ error, resetError }: ErrorFallbackProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const [isModalVisible, setIsModalVisible] = useState(false);

  const handleRestart = async () => {
    try {
      await reloadAppAsync();
    } catch (restartError) {
      console.error("Failed to restart app:", restartError);
      resetError();
    }
  };

  const formatErrorDetails = (): string => {
    let details = `Error: ${error.message}\n\n`;
    if (error.stack) {
      details += `Stack Trace:\n${error.stack}`;
    }
    return details;
  };

  // Single plain-text blob for the "Copy details" button: build info,
  // then message, then stack. componentStack is NOT available here —
  // the boundary passes only { error, resetError } to its fallback —
  // so it is named explicitly rather than silently omitted.
  const buildCopyBlob = (): string =>
    [
      "—— Build ——",
      formatBuildInfo(),
      "",
      "—— Error ——",
      error.message,
      "",
      "—— Stack ——",
      error.stack ?? "unavailable",
      "",
      "—— Component stack ——",
      "unavailable (not passed to ErrorFallback)",
    ].join("\n");

  const [copied, setCopied] = useState(false);
  const copyDetails = async () => {
    try {
      await Clipboard.setStringAsync(buildCopyBlob());
      setCopied(true);
    } catch {
      /* never throw from the fallback */
    }
  };

  const monoFont = Platform.select({
    ios: "Menlo",
    android: "monospace",
    default: "monospace",
  });

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* TEMPORARY DIAGNOSTIC — not permanent UI. The details pressable
        * and modal below were __DEV__-gated; the gate is removed so the
        * walkthrough-Done crash can be read on a production device.
        * Restore the __DEV__ gates once the crash is identified. */}
      {true ? (
        <Pressable
          onPress={() => setIsModalVisible(true)}
          accessibilityLabel="View error details"
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.topButton,
            {
              top: insets.top + 16,
              backgroundColor: colors.card,
              opacity: pressed ? 0.8 : 1,
            },
          ]}
        >
          <Feather name="alert-circle" size={20} color={colors.foreground} />
        </Pressable>
      ) : null}

      <View style={styles.content}>
        <Text style={[styles.title, { color: colors.foreground }]}>
          Something went wrong
        </Text>

        {__DEV__ ? (
          <View
            style={[
              styles.devBox,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <Text
              selectable
              style={[
                styles.devMessage,
                { color: colors.destructive, fontFamily: monoFont },
              ]}
            >
              {error.name ? `${error.name}: ` : ""}
              {error.message}
            </Text>
            <Text
              style={[styles.devHint, { color: colors.mutedForeground }]}
            >
              Tap the alert icon (top right) for the full stack trace.
            </Text>
          </View>
        ) : (
          <Text style={[styles.message, { color: colors.mutedForeground }]}>
            Please reload the app to continue.
          </Text>
        )}

        <Pressable
          onPress={handleRestart}
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: colors.primary,
              opacity: pressed ? 0.9 : 1,
              transform: [{ scale: pressed ? 0.98 : 1 }],
            },
          ]}
        >
          <Text
            style={[
              styles.buttonText,
              { color: colors.primaryForeground },
            ]}
          >
            Try Again
          </Text>
        </Pressable>
      </View>

      {/* TEMPORARY DIAGNOSTIC — see comment above; was __DEV__-gated. */}
      {true ? (
        <Modal
          visible={isModalVisible}
          animationType="slide"
          transparent={true}
          onRequestClose={() => setIsModalVisible(false)}
        >
          <View style={styles.modalOverlay}>
            <View
              style={[
                styles.modalContainer,
                { backgroundColor: colors.background },
              ]}
            >
              <View
                style={[
                  styles.modalHeader,
                  { borderBottomColor: colors.border },
                ]}
              >
                <Text style={[styles.modalTitle, { color: colors.foreground }]}>
                  Error Details
                </Text>
                <Pressable
                  onPress={() => setIsModalVisible(false)}
                  accessibilityLabel="Close error details"
                  accessibilityRole="button"
                  style={({ pressed }) => [
                    styles.closeButton,
                    { opacity: pressed ? 0.6 : 1 },
                  ]}
                >
                  <Feather name="x" size={24} color={colors.foreground} />
                </Pressable>
              </View>

              <ScrollView
                style={styles.modalScrollView}
                contentContainerStyle={[
                  styles.modalScrollContent,
                  { paddingBottom: insets.bottom + 16 },
                ]}
                showsVerticalScrollIndicator
              >
                {/* Build identity above the stack — which bundle is this
                  * device actually running? (TEMP diagnostic surface.) */}
                <View
                  style={[
                    styles.errorContainer,
                    { backgroundColor: colors.card, marginBottom: 12 },
                  ]}
                >
                  <Text
                    style={[
                      styles.errorText,
                      { color: colors.foreground, fontFamily: monoFont },
                    ]}
                    selectable
                  >
                    {formatBuildInfo(getBuildInfo())}
                  </Text>
                </View>
                <Pressable
                  onPress={() => void copyDetails()}
                  accessibilityRole="button"
                  accessibilityLabel="Copy details"
                  style={({ pressed }) => [
                    styles.copyButton,
                    {
                      backgroundColor: colors.card,
                      borderColor: colors.border,
                      opacity: pressed ? 0.8 : 1,
                    },
                  ]}
                >
                  <Feather
                    name={copied ? "check" : "copy"}
                    size={16}
                    color={colors.foreground}
                  />
                  <Text style={[styles.copyLabel, { color: colors.foreground }]}>
                    {copied ? "Copied" : "Copy details"}
                  </Text>
                </Pressable>
                <View
                  style={[
                    styles.errorContainer,
                    { backgroundColor: colors.card },
                  ]}
                >
                  <Text
                    style={[
                      styles.errorText,
                      {
                        color: colors.foreground,
                        fontFamily: monoFont,
                      },
                    ]}
                    selectable
                  >
                    {formatErrorDetails()}
                  </Text>
                </View>
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: "100%",
    height: "100%",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  content: {
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    width: "100%",
    maxWidth: 600,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    textAlign: "center",
    lineHeight: 40,
  },
  message: {
    fontSize: 16,
    textAlign: "center",
    lineHeight: 24,
  },
  topButton: {
    position: "absolute",
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },
  button: {
    paddingVertical: 16,
    borderRadius: 8,
    paddingHorizontal: 24,
    minWidth: 200,
    shadowColor: "#000",
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  buttonText: {
    fontWeight: "600",
    textAlign: "center",
    fontSize: 16,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "flex-end",
  },
  modalContainer: {
    width: "100%",
    height: "90%",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "600",
  },
  closeButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  modalScrollView: {
    flex: 1,
  },
  modalScrollContent: {
    padding: 16,
  },
  errorContainer: {
    width: "100%",
    borderRadius: 8,
    overflow: "hidden",
    padding: 16,
  },
  errorText: {
    fontSize: 12,
    lineHeight: 18,
    width: "100%",
  },
  devBox: {
    width: "100%",
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 8,
  },
  devMessage: {
    fontSize: 13,
    lineHeight: 18,
  },
  devHint: {
    fontSize: 12,
    lineHeight: 16,
  },
  copyButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    marginBottom: 12,
  },
  copyLabel: {
    fontSize: 14,
    fontWeight: "600",
  },
});
