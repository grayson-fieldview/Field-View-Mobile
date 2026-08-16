import React, { useEffect, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { VoiceNoteButton } from "@/components/VoiceNoteButton";
import { useColors } from "@/hooks/useColors";
import { api } from "@/services/api";

/**
 * "Generate with AI" dialog for checklists. Presented as a full-screen
 * slide Modal — the same presentation TemplatePickerModal uses for the
 * existing checklist-create flow.
 *
 * The user types a description and/or records a voice note (the
 * transcript APPENDS to whatever is typed — never replaces). Generate
 * POSTs /api/projects/:id/checklists/generate; on success the parent
 * refreshes the list and navigates to the new checklist.
 *
 * Server errors render inline: 400 (nothing actionable found) and 429
 * (monthly limit) both return readable messages.
 */

interface Props {
  visible: boolean;
  onClose: () => void;
  projectId: string | number;
  /** Called after a successful generate, BEFORE the sheet closes itself. */
  onCreated: (checklistId: number) => void;
}

export function ChecklistGenerateSheet({
  visible,
  onClose,
  projectId,
  onCreated,
}: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [note, setNote] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh state each time the sheet opens.
  useEffect(() => {
    if (visible) {
      setNote("");
      setVoiceBusy(false);
      setGenerating(false);
      setError(null);
    }
  }, [visible]);

  const canGenerate = note.trim().length > 0 && !voiceBusy && !generating;

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setGenerating(true);
    setError(null);
    try {
      const { checklistId } = await api.generateChecklist(
        projectId,
        note.trim(),
      );
      onCreated(checklistId);
      onClose();
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? e.message
          : "Couldn't generate a checklist.",
      );
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <View
          style={[
            styles.header,
            { paddingTop: insets.top + 8, borderBottomColor: colors.border },
          ]}
        >
          <Pressable onPress={onClose} hitSlop={10} disabled={generating}>
            <Text
              style={[
                styles.headerBtn,
                { color: colors.primary, opacity: generating ? 0.5 : 1 },
              ]}
            >
              Cancel
            </Text>
          </Pressable>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>
            Generate with AI
          </Text>
          <View style={{ width: 50 }} />
        </View>

        <View style={styles.body}>
          <View style={styles.labelRow}>
            <Text style={[styles.label, { color: colors.foreground }]}>
              What should be on it?
            </Text>
            <VoiceNoteButton
              disabled={generating}
              onBusyChange={setVoiceBusy}
              onTranscript={(text) =>
                // APPEND with a space — never replace what's typed.
                setNote((prev) => (prev ? `${prev} ${text}` : text))
              }
            />
          </View>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="Describe what needs to get done"
            placeholderTextColor={colors.mutedForeground}
            multiline
            editable={!generating}
            style={[
              styles.input,
              {
                color: colors.foreground,
                backgroundColor: colors.card,
                borderColor: colors.border,
              },
            ]}
          />
          {error ? (
            <Text style={[styles.error, { color: colors.destructive }]}>
              {error}
            </Text>
          ) : null}
          <Button
            title="Generate"
            onPress={() => void handleGenerate()}
            loading={generating}
            disabled={!canGenerate}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: {
    fontFamily: "Inter_500Medium",
    fontSize: 15,
    width: 50,
  },
  headerTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
  },
  body: {
    padding: 16,
    gap: 12,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  label: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    paddingTop: 8,
  },
  input: {
    minHeight: 120,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    textAlignVertical: "top",
  },
  error: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
});
