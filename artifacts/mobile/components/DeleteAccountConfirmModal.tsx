import React, { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Button } from "@/components/Button";
import { useColors } from "@/hooks/useColors";

/**
 * Second-step confirmation for account deletion. The user must type the
 * literal string "DELETE" (case-sensitive) AND re-enter their password.
 *
 * The parent owns the network call. `onConfirm` should:
 *   - resolve on success (parent will close the modal)
 *   - throw an error on failure. Errors with a `.status` property of 401
 *     are surfaced inline as "Incorrect password"; other errors bubble up
 *     for the parent to handle (toast / alert).
 */
export function DeleteAccountConfirmModal({
  visible,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  onCancel: () => void;
  onConfirm: (password: string) => Promise<void>;
}) {
  const colors = useColors();
  const [confirmText, setConfirmText] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  // Reset state every time the modal opens / closes.
  useEffect(() => {
    if (!visible) {
      setConfirmText("");
      setPassword("");
      setSubmitting(false);
      setPasswordError(null);
    }
  }, [visible]);

  const canSubmit =
    confirmText === "DELETE" && password.length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setPasswordError(null);
    try {
      await onConfirm(password);
      // Parent will close the modal on success.
    } catch (e) {
      const status =
        typeof e === "object" && e !== null && "status" in e
          ? (e as { status?: number }).status
          : undefined;
      if (status === 401) {
        setPasswordError("Incorrect password");
      } else {
        // Bubble up so the parent can show an Alert / toast.
        setPasswordError(
          e instanceof Error ? e.message : "Something went wrong. Try again.",
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={onCancel}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.backdrop}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={submitting ? undefined : onCancel}
          accessibilityLabel="Close"
        />
        <View style={[styles.card, { backgroundColor: colors.background }]}>
          <Text style={[styles.title, { color: colors.foreground }]}>
            Type DELETE to confirm
          </Text>
          <Text style={[styles.body, { color: colors.mutedForeground }]}>
            This action cannot be undone for 30 days. After that, all data is
            permanently destroyed.
          </Text>

          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>
              Confirmation
            </Text>
            <TextInput
              value={confirmText}
              onChangeText={setConfirmText}
              placeholder="DELETE"
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="characters"
              autoCorrect={false}
              spellCheck={false}
              editable={!submitting}
              style={[
                styles.input,
                {
                  color: colors.foreground,
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  fontFamily: "Inter_600SemiBold",
                  letterSpacing: 1,
                },
              ]}
            />
          </View>

          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>
              Re-enter your password
            </Text>
            <TextInput
              value={password}
              onChangeText={(v) => {
                setPassword(v);
                if (passwordError) setPasswordError(null);
              }}
              placeholder="Password"
              placeholderTextColor={colors.mutedForeground}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="current-password"
              textContentType="password"
              editable={!submitting}
              style={[
                styles.input,
                {
                  color: colors.foreground,
                  backgroundColor: colors.card,
                  borderColor: passwordError
                    ? colors.destructive
                    : colors.border,
                },
              ]}
            />
            {passwordError ? (
              <Text style={[styles.error, { color: colors.destructive }]}>
                {passwordError}
              </Text>
            ) : null}
          </View>

          <View style={styles.actions}>
            <View style={{ flex: 1 }}>
              <Button
                title="Cancel"
                variant="secondary"
                onPress={onCancel}
                disabled={submitting}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                title="Delete account"
                variant="danger"
                onPress={handleSubmit}
                disabled={!canSubmit}
                loading={submitting}
              />
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  card: {
    width: "100%",
    maxWidth: 480,
    borderRadius: 18,
    padding: 22,
    gap: 16,
  },
  title: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.3,
  },
  body: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
  field: { gap: 6 },
  label: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 16,
    fontFamily: "Inter_500Medium",
  },
  error: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
});
