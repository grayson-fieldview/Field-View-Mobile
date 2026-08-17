import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { VoiceNoteButton } from "@/components/VoiceNoteButton";
import { useData } from "@/contexts/DataContext";
import { useColors } from "@/hooks/useColors";
import {
  ApiError,
  REPORT_TYPES,
  REPORT_TYPE_LABELS,
  type ReportType,
  api,
} from "@/services/api";

/** Server cap on mediaIds per generate call. Enforced client-side too. */
const MAX_PHOTOS = 75;
const MAX_NOTE_LENGTH = 5000;

const TILE_GAP = 8;
const TILES_PER_ROW = 3;

interface Props {
  visible: boolean;
  onClose: () => void;
  projectId: string | number;
  /** Called after a successful generate, BEFORE the sheet closes itself. */
  onCreated: (reportId: number | string, excludedCount: number) => void;
}

/**
 * "Generate with AI" flow for reports: select up to 75 project photos,
 * add an optional note, pick a report type, generate.
 *
 * POST /api/projects/:id/reports/generate is SYNCHRONOUS and can run
 * tens of seconds. While it's in flight the sheet is deliberately
 * locked down (no cancel, no back-dismiss, blocking progress copy) so
 * a slow success can never look like a failure — abandoning the screen
 * mid-flight would leave the user thinking nothing happened while the
 * report quietly appears later.
 */
export function GenerateReportSheet({
  visible,
  onClose,
  projectId,
  onCreated,
}: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { photos } = useData();

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [note, setNote] = useState("");
  // Defaults to client_update, matching web's dialog.
  const [reportType, setReportType] = useState<ReportType>("client_update");
  const [generating, setGenerating] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset per open.
  useEffect(() => {
    if (visible) {
      setSelected(new Set());
      setNote("");
      setReportType("client_update");
      setGenerating(false);
      setVoiceBusy(false);
      setError(null);
    }
  }, [visible]);

  // Remote project photos with numeric media ids (local-only rows have
  // nanoid ids and don't exist server-side yet — they can't be cited).
  const candidates = useMemo(() => {
    const idStr = String(projectId);
    return photos.filter((p) => {
      if (p.projectId !== idStr) return false;
      if (!p.remote) return false;
      return Number.isFinite(Number(p.id));
    });
  }, [photos, projectId]);

  const tileSize =
    (width - 20 * 2 - TILE_GAP * (TILES_PER_ROW - 1)) / TILES_PER_ROW;

  const toggle = (mediaId: number) => {
    if (generating) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(mediaId)) next.delete(mediaId);
      else if (next.size < MAX_PHOTOS) next.add(mediaId);
      return next;
    });
  };

  // reportType always holds a valid value now (defaulted, non-null).
  // voiceBusy: a recording/transcription in flight must block submit —
  // otherwise the note could be sent without the pending transcript.
  const canGenerate = selected.size > 0 && !generating && !voiceBusy;

  const generate = async () => {
    if (!canGenerate) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await api.generateProjectReport(projectId, {
        mediaIds: [...selected],
        note,
        reportType,
      });
      onCreated(res.reportId, res.excludedCount);
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        setError(
          e.message && e.message.length < 200
            ? e.message
            : "You've hit this month's AI report limit. It resets next month.",
        );
      } else if (e instanceof ApiError && e.status === 503) {
        setError(
          "The AI service is busy right now. Your photos are safe — try again in a few minutes.",
        );
      } else if (e instanceof ApiError && e.status === 400) {
        setError(
          e.message && e.message.length < 200
            ? e.message
            : "The server couldn't use this selection. Adjust the photos or note and try again.",
        );
      } else {
        setError(
          "Report generation failed or the connection dropped. Check the Reports tab before retrying — the report may still have been created.",
        );
      }
      setGenerating(false);
      return;
    }
    setGenerating(false);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={generating || voiceBusy ? undefined : onClose}
    >
      {/* Same keyboard pattern as ApplyReportTemplateModal: KAV around
          the whole sheet so the pinned footer (and the note input above
          it) lift with the keyboard. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{
          flex: 1,
          backgroundColor: colors.background,
          paddingTop: insets.top,
        }}
      >
        <View style={styles.header}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>
            Generate report
          </Text>
          <Pressable
            onPress={generating || voiceBusy ? undefined : onClose}
            hitSlop={12}
            disabled={generating || voiceBusy}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={{ opacity: generating || voiceBusy ? 0.35 : 1 }}
          >
            <Feather name="x" size={22} color={colors.foreground} />
          </Pressable>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingBottom: 24,
            gap: 16,
          }}
          scrollEnabled={!generating}
        >
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
            Report type
          </Text>
          <View style={styles.chipRow}>
            {REPORT_TYPES.map((t) => {
              const active = reportType === t;
              return (
                <Pressable
                  key={t}
                  onPress={() => !generating && setReportType(t)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: active ? colors.primary : colors.muted,
                      borderColor: active ? colors.primary : colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.chipLabel,
                      {
                        color: active
                          ? colors.primaryForeground
                          : colors.foreground,
                      },
                    ]}
                  >
                    {REPORT_TYPE_LABELS[t]}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.labelRow}>
            <Text
              style={[styles.sectionLabel, { color: colors.mutedForeground }]}
            >
              Note (optional)
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
            placeholder="Anything the report should focus on…"
            placeholderTextColor={colors.mutedForeground}
            multiline
            maxLength={MAX_NOTE_LENGTH}
            editable={!generating}
            style={[
              styles.noteInput,
              {
                color: colors.foreground,
                borderColor: colors.border,
                backgroundColor: colors.card,
              },
            ]}
          />

          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
            Photos · {selected.size}/{MAX_PHOTOS}
          </Text>
          {candidates.length === 0 ? (
            <EmptyState
              icon="camera"
              title="No synced photos"
              description="Photos must finish uploading before they can go into a report."
            />
          ) : (
            <View style={styles.grid}>
              {candidates.map((p) => {
                const mediaId = Number(p.id);
                const isSelected = selected.has(mediaId);
                const capped = !isSelected && selected.size >= MAX_PHOTOS;
                return (
                  <Pressable
                    key={p.id}
                    onPress={() => toggle(mediaId)}
                    disabled={capped || generating}
                    style={{
                      width: tileSize,
                      height: tileSize,
                      opacity: capped ? 0.35 : 1,
                    }}
                  >
                    <Image
                      source={{ uri: p.thumbUrl ?? p.uri }}
                      style={StyleSheet.absoluteFill}
                      contentFit="cover"
                      recyclingKey={String(p.id)}
                    />
                    {isSelected ? (
                      <View
                        style={[
                          styles.checkBadge,
                          { backgroundColor: colors.primary },
                        ]}
                      >
                        <Feather
                          name="check"
                          size={13}
                          color={colors.primaryForeground}
                        />
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          )}

        </ScrollView>

        {/* Pinned footer: error/progress + Generate stay reachable
            without scrolling past the photo grid. */}
        <View
          style={[
            styles.footer,
            {
              borderTopColor: colors.border,
              backgroundColor: colors.background,
              paddingBottom: insets.bottom + 12,
            },
          ]}
        >
          {error ? (
            <Text style={[styles.error, { color: colors.destructive }]}>
              {error}
            </Text>
          ) : null}

          {generating ? (
            <View style={styles.progressRow}>
              <ActivityIndicator color={colors.primary} />
              <Text
                style={[styles.progressText, { color: colors.mutedForeground }]}
              >
                Generating your report — this can take a minute. Keep the app
                open.
              </Text>
            </View>
          ) : null}

          <Button
            title={generating ? "Generating…" : "Generate report"}
            loading={generating}
            disabled={!canGenerate}
            onPress={() => void generate()}
          />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: -0.3,
  },
  sectionLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: TILE_GAP,
  },
  checkBadge: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  noteInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: 90,
    textAlignVertical: "top",
    fontSize: 15,
    fontFamily: "Inter_500Medium",
  },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 12,
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  error: { fontSize: 13, fontFamily: "Inter_500Medium", lineHeight: 18 },
  progressRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  progressText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    lineHeight: 18,
  },
});
