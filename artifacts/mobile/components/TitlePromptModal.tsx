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

interface Props {
  visible: boolean;
  /** Card heading, e.g. "New checklist". */
  heading: string;
  placeholder: string;
  submitLabel: string;
  /** Label swapped in while onSubmit is in flight. */
  busyLabel: string;
  onClose: () => void;
  /**
   * Parent owns the create + navigation. Throw to keep the modal open
   * (the error message renders inline); resolve to close it.
   */
  onSubmit: (title: string) => Promise<void>;
}

/**
 * Minimal centered title prompt — the cross-platform stand-in for
 * iOS-only Alert.prompt. Used by the manual "Create new" paths on the
 * checklists and reports tabs.
 */
export function TitlePromptModal({
  visible,
  heading,
  placeholder,
  submitLabel,
  busyLabel,
  onClose,
  onSubmit,
}: Props) {
  const colors = useColors();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset per open.
  useEffect(() => {
    if (visible) {
      setTitle("");
      setBusy(false);
      setError(null);
    }
  }, [visible]);

  const trimmed = title.trim();

  const submit = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create it.");
      setBusy(false);
      return;
    }
    setBusy(false);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={busy ? undefined : onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.backdrop}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={busy ? undefined : onClose}
        />
        <View
          style={[
            styles.card,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.heading, { color: colors.foreground }]}>
            {heading}
          </Text>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder={placeholder}
            placeholderTextColor={colors.mutedForeground}
            autoFocus
            maxLength={200}
            editable={!busy}
            onSubmitEditing={() => void submit()}
            returnKeyType="done"
            style={[
              styles.input,
              {
                color: colors.foreground,
                borderColor: colors.border,
                backgroundColor: colors.background,
              },
            ]}
          />
          {error ? (
            <Text style={[styles.error, { color: colors.destructive }]}>
              {error}
            </Text>
          ) : null}
          <View style={styles.row}>
            <Button
              title="Cancel"
              variant="secondary"
              onPress={onClose}
              disabled={busy}
              style={styles.rowBtn}
            />
            <Button
              title={busy ? busyLabel : submitLabel}
              onPress={() => void submit()}
              loading={busy}
              disabled={!trimmed}
              style={styles.rowBtn}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
    gap: 12,
  },
  heading: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: -0.2,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_500Medium",
  },
  error: { fontSize: 13, fontFamily: "Inter_500Medium" },
  row: { flexDirection: "row", gap: 10 },
  rowBtn: { flex: 1 },
});
