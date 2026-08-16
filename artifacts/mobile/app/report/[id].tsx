import { Feather } from "@expo/vector-icons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import KebabIcon from "@/components/KebabIcon";
import { ReportPhotoPickerModal } from "@/components/ReportPhotoPickerModal";
import { ReportSectionCard } from "@/components/ReportSectionCard";
import { useToast } from "@/contexts/ToastContext";
import { useColors } from "@/hooks/useColors";
import { REPORT_PHOTO_CAP, useReportDetail } from "@/hooks/useReportDetail";
import { ApiError, api } from "@/services/api";
import { downloadAndSharePdf } from "@/services/reportPdf";

const TITLE_DEBOUNCE_MS = 500;

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
};

/**
 * Mobile Reports R1 detail screen.
 *
 * Mirrors app/checklist/[id].tsx in shape:
 *  - Loads the full tree (sections + photos) via useReportDetail.
 *  - Inline editable title (debounced PATCH) on the report header.
 *  - Sections rendered as ReportSectionCard's, each owning its own
 *    title/summary debounce + photo strip.
 *  - "+ Add section" appends an empty section at the bottom.
 *  - Header kebab opens "Generate & share PDF" + "Delete report".
 *  - Photo cap (50) is shown next to the Generate button and enforced
 *    in the picker modal via remainingSlots.
 *
 * Status workflow transitions (draft → submitted → approved) are
 * web-only for R1 — mobile shows the pill but doesn't expose any
 * action to change it.
 */
export default function ReportDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { showToast } = useToast();
  const params = useLocalSearchParams<{
    id: string;
    projectId?: string;
  }>();
  const reportId = params.id;
  const projectId = params.projectId;

  const detail = useReportDetail(reportId);
  const {
    report,
    sections,
    totalPhotoCount,
    loading,
    error,
    refresh,
    updateReportMeta,
    addSection,
    updateSection,
    deleteSection,
    attachPhotos,
    updatePhoto,
    detachPhoto,
  } = detail;

  // ----- Debounced title editing -----
  const [title, setTitle] = useState("");
  const titleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedTitleRef = useRef("");

  useEffect(() => {
    if (report && titleTimerRef.current === null) {
      setTitle(report.title);
      lastSavedTitleRef.current = report.title;
    }
  }, [report]);

  useEffect(() => {
    return () => {
      if (titleTimerRef.current) clearTimeout(titleTimerRef.current);
    };
  }, []);

  const onTitleChange = (v: string) => {
    setTitle(v);
    if (titleTimerRef.current) clearTimeout(titleTimerRef.current);
    titleTimerRef.current = setTimeout(() => {
      titleTimerRef.current = null;
      const trimmed = v.trim();
      if (!trimmed || trimmed === lastSavedTitleRef.current) return;
      lastSavedTitleRef.current = trimmed;
      updateReportMeta({ title: trimmed }).catch((e) =>
        showToast(e instanceof Error ? e.message : "Couldn't save title."),
      );
    }, TITLE_DEBOUNCE_MS);
  };

  // ----- Add-section state -----
  const [addingSection, setAddingSection] = useState(false);
  const [newSectionTitle, setNewSectionTitle] = useState("");
  const [creatingSection, setCreatingSection] = useState(false);

  const submitNewSection = async () => {
    const t = newSectionTitle.trim();
    if (!t) return;
    setCreatingSection(true);
    try {
      await addSection({ title: t });
      setNewSectionTitle("");
      setAddingSection(false);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Couldn't add section.");
    } finally {
      setCreatingSection(false);
    }
  };

  // ----- Photo picker -----
  const [pickerSectionId, setPickerSectionId] = useState<string | null>(null);
  const remainingSlots = Math.max(0, REPORT_PHOTO_CAP - totalPhotoCount);
  const pickerSection = pickerSectionId
    ? sections.find((s) => String(s.id) === pickerSectionId)
    : null;

  // ----- Generate / share PDF -----
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const handleGeneratePdf = async () => {
    if (!report) return;
    if (totalPhotoCount === 0) {
      Alert.alert(
        "Add photos first",
        "Reports need at least one photo before they can be generated.",
      );
      return;
    }
    setGeneratingPdf(true);
    try {
      await downloadAndSharePdf(report.id, report.title);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Couldn't generate PDF.");
    } finally {
      setGeneratingPdf(false);
    }
  };

  // ----- Copy share link (kebab) -----
  const [sharingReport, setSharingReport] = useState(false);
  const handleShareReport = async () => {
    if (!report || sharingReport) return;
    // Reuse an existing token; only mint when the report has none.
    let token =
      typeof report.shareToken === "string" && report.shareToken.length > 0
        ? report.shareToken
        : null;
    if (!token) {
      setSharingReport(true);
      try {
        const res = await api.shareReport(report.id);
        token = res.shareToken;
      } catch (e) {
        setSharingReport(false);
        if (e instanceof ApiError && e.status === 401) return;
        if (e instanceof ApiError && e.status === 409) {
          showToast(
            "This report is still generating — try sharing once it's ready.",
          );
          return;
        }
        showToast(
          e instanceof Error ? e.message : "Couldn't create share link.",
        );
        return;
      }
      setSharingReport(false);
    }
    // Hard-coded public web origin, same reasoning as project shares:
    // recipients open this in Safari, so it must not follow the API base.
    const shareUrl = `https://app.field-view.com/report/${token}`;
    showToast("Share link ready");
    try {
      // url-only — url+message double-renders link previews in iMessage.
      await Share.share({ url: shareUrl });
    } catch {
      /* user cancelled */
    }
  };

  // ----- Delete report (kebab) -----
  const handleDeleteReport = () => {
    if (!report) return;
    Alert.alert(
      "Delete this report?",
      "This permanently removes the report, all of its sections, and the photo attachments. The underlying photos are not deleted.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await api.deleteReport(report.id);
              showToast("Report deleted");
              router.back();
            } catch (e) {
              if (e instanceof ApiError && e.status === 401) return;
              showToast(
                e instanceof Error ? e.message : "Couldn't delete report.",
              );
            }
          },
        },
      ],
    );
  };

  const openKebab = () => {
    if (!report) return;
    const pdfLabel = generatingPdf ? "Generating PDF…" : "Generate & share PDF";
    const shareLabel = sharingReport
      ? "Creating share link…"
      : "Copy share link";
    if (Platform.OS === "ios") {
      const disabled: number[] = [];
      if (generatingPdf) disabled.push(1);
      if (sharingReport) disabled.push(2);
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["Cancel", pdfLabel, shareLabel, "Delete report"],
          cancelButtonIndex: 0,
          destructiveButtonIndex: 3,
          disabledButtonIndices: disabled,
        },
        (idx) => {
          if (idx === 1) void handleGeneratePdf();
          else if (idx === 2) void handleShareReport();
          else if (idx === 3) handleDeleteReport();
        },
      );
    } else {
      Alert.alert("Report", undefined, [
        { text: "Cancel", style: "cancel" },
        { text: pdfLabel, onPress: () => void handleGeneratePdf() },
        { text: shareLabel, onPress: () => void handleShareReport() },
        {
          text: "Delete report",
          style: "destructive",
          onPress: handleDeleteReport,
        },
      ]);
    }
  };

  const headerTitle = report?.title ?? "Report";
  const status = report?.status ?? "draft";
  const statusColor =
    status === "approved"
      ? colors.success
      : status === "submitted"
        ? colors.primary
        : colors.mutedForeground;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: headerTitle,
          headerBackTitle: "Back",
          headerRight: () =>
            report ? (
              <Pressable onPress={openKebab} hitSlop={10}>
                <KebabIcon size={22} color={colors.foreground} />
              </Pressable>
            ) : null,
        }}
      />

      {loading && !report ? (
        <View style={[styles.center, { paddingTop: insets.top + 80 }]}>
          <ActivityIndicator color={colors.mutedForeground} />
        </View>
      ) : error && !report ? (
        <View style={[styles.center, { padding: 24, gap: 12 }]}>
          <Text
            style={{
              color: colors.destructive,
              fontFamily: "Inter_500Medium",
              textAlign: "center",
            }}
          >
            {error}
          </Text>
          <Button
            title="Retry"
            variant="secondary"
            onPress={() => void refresh()}
          />
        </View>
      ) : report ? (
        <ScrollView
          contentContainerStyle={{
            padding: 16,
            paddingBottom: insets.bottom + 100,
            gap: 14,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <View
            style={[
              styles.headerCard,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <TextInput
              value={title}
              onChangeText={onTitleChange}
              placeholder="Report title"
              placeholderTextColor={colors.mutedForeground}
              style={[styles.titleInput, { color: colors.foreground }]}
            />
            <View style={styles.metaRow}>
              <View
                style={[
                  styles.statusPill,
                  { backgroundColor: colors.muted, borderColor: colors.border },
                ]}
              >
                <View
                  style={[styles.statusDot, { backgroundColor: statusColor }]}
                />
                <Text style={[styles.statusLabel, { color: statusColor }]}>
                  {STATUS_LABEL[status] ?? status}
                </Text>
              </View>
              <Text
                style={[
                  styles.metaText,
                  {
                    color:
                      totalPhotoCount >= REPORT_PHOTO_CAP
                        ? colors.destructive
                        : colors.mutedForeground,
                  },
                ]}
              >
                {totalPhotoCount} / {REPORT_PHOTO_CAP} photos
              </Text>
            </View>
            {totalPhotoCount >= REPORT_PHOTO_CAP ? (
              <Text
                style={{
                  color: colors.destructive,
                  fontFamily: "Inter_500Medium",
                  fontSize: 12,
                }}
              >
                Photo cap reached. Detach photos before adding more.
              </Text>
            ) : null}
            <Button
              title={generatingPdf ? "Generating…" : "Generate & share PDF"}
              icon={
                generatingPdf ? null : (
                  <Feather
                    name="share"
                    size={14}
                    color={colors.primaryForeground}
                  />
                )
              }
              loading={generatingPdf}
              onPress={() => void handleGeneratePdf()}
            />
          </View>

          {sections.map((s) => (
            <ReportSectionCard
              key={String(s.id)}
              section={s}
              onUpdateMeta={(patch) => updateSection(s.id, patch)}
              onDelete={() => deleteSection(s.id)}
              onAddPhoto={() => setPickerSectionId(String(s.id))}
              onUpdatePhoto={(pid, patch) => updatePhoto(s.id, pid, patch)}
              onDetachPhoto={(pid) => detachPhoto(s.id, pid)}
            />
          ))}

          {addingSection ? (
            <View
              style={[
                styles.addSectionCard,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <TextInput
                value={newSectionTitle}
                onChangeText={setNewSectionTitle}
                placeholder="New section title"
                placeholderTextColor={colors.mutedForeground}
                autoFocus
                editable={!creatingSection}
                style={[
                  styles.titleInput,
                  { color: colors.foreground, fontSize: 15 },
                ]}
              />
              <View style={{ flexDirection: "row", gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Button
                    title="Cancel"
                    variant="secondary"
                    onPress={() => {
                      setNewSectionTitle("");
                      setAddingSection(false);
                    }}
                    disabled={creatingSection}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    title="Add"
                    loading={creatingSection}
                    disabled={!newSectionTitle.trim()}
                    onPress={() => void submitNewSection()}
                  />
                </View>
              </View>
            </View>
          ) : (
            <Pressable
              onPress={() => setAddingSection(true)}
              style={({ pressed }) => [
                styles.addSectionBtn,
                { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <Feather name="plus" size={16} color={colors.primary} />
              <Text
                style={{
                  color: colors.primary,
                  fontFamily: "Inter_600SemiBold",
                  fontSize: 14,
                }}
              >
                Add section
              </Text>
            </Pressable>
          )}

          {sections.length === 0 && !addingSection ? (
            <View style={{ alignItems: "center", padding: 24, gap: 8 }}>
              <Feather
                name="file-text"
                size={28}
                color={colors.mutedForeground}
              />
              <Text
                style={{
                  color: colors.mutedForeground,
                  textAlign: "center",
                  fontFamily: "Inter_500Medium",
                  fontSize: 13,
                }}
              >
                This report has no sections yet. Add one to get started.
              </Text>
            </View>
          ) : null}
        </ScrollView>
      ) : null}

      {pickerSection && projectId ? (
        <ReportPhotoPickerModal
          visible={true}
          onClose={() => setPickerSectionId(null)}
          projectId={projectId}
          alreadyAttachedMediaIds={
            new Set(pickerSection.photos.map((p) => p.mediaId))
          }
          remainingSlots={remainingSlots}
          onAttach={(mediaIds) => attachPhotos(pickerSection.id, mediaIds)}
          onResult={(succeeded, failed) => {
            if (failed) {
              showToast("Couldn't attach photos.");
            } else if (succeeded > 0) {
              showToast(
                `Attached ${succeeded} photo${succeeded === 1 ? "" : "s"}.`,
              );
            }
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerCard: {
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    gap: 10,
  },
  titleInput: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.3,
    paddingVertical: 4,
  },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    textTransform: "capitalize",
  },
  metaText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  addSectionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "dashed",
  },
  addSectionCard: {
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    gap: 10,
  },
});
