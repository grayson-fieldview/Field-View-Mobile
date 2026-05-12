import { Feather } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
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
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { useColors } from "@/hooks/useColors";
import { ApiError, api, type BackendReportTemplate } from "@/services/api";

interface Props {
  visible: boolean;
  onClose: () => void;
  /**
   * Parent owns the create + navigation. Receives `{title, templateId?}` —
   * `templateId` is omitted entirely (not null) for blank reports, since
   * the server rejects null/0 for that field.
   */
  onCreate: (input: {
    title: string;
    templateId?: string | number;
  }) => Promise<void>;
}

/**
 * Section count is derived from `templateConfig.sections.length` because
 * report templates store their structure as a single jsonb blob (no
 * separate report_template_sections table). Server validates the shape
 * via templateConfigSchema, so we can trust the array exists when
 * `templateConfig.sections` is an array.
 */
function templateSectionCount(t: BackendReportTemplate): number {
  if (typeof t.sectionCount === "number") return t.sectionCount;
  const cfg = t.templateConfig as { sections?: unknown } | null | undefined;
  if (cfg && Array.isArray(cfg.sections)) return cfg.sections.length;
  return 0;
}

export function ApplyReportTemplateModal({
  visible,
  onClose,
  onCreate,
}: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [templates, setTemplates] = useState<BackendReportTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [blankTitle, setBlankTitle] = useState("");
  const [creatingBlank, setCreatingBlank] = useState(false);

  // Reset form + reload templates each time the modal is opened.
  useEffect(() => {
    if (!visible) return;
    setBlankTitle("");
    setError(null);
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const list = await api.listReportTemplates();
        if (cancelled) return;
        setTemplates(Array.isArray(list) ? list : []);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) return;
        setError(e instanceof Error ? e.message : "Couldn't load templates.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const choose = async (t: BackendReportTemplate) => {
    setPickingId(String(t.id));
    setError(null);
    try {
      await onCreate({ title: t.title, templateId: t.id });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create report.");
    } finally {
      setPickingId(null);
    }
  };

  const createBlank = async () => {
    const title = blankTitle.trim();
    if (!title) return;
    setCreatingBlank(true);
    setError(null);
    try {
      // NOTE: omit templateId entirely for blank reports — sending
      // null or 0 will 400 server-side.
      await onCreate({ title });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create report.");
    } finally {
      setCreatingBlank(false);
    }
  };

  const busy = pickingId !== null || creatingBlank;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1, backgroundColor: colors.background }}
      >
        <View
          style={[
            styles.header,
            { paddingTop: insets.top + 8, borderBottomColor: colors.border },
          ]}
        >
          <Pressable onPress={onClose} hitSlop={10} disabled={busy}>
            <Text
              style={[
                styles.headerBtn,
                { color: busy ? colors.mutedForeground : colors.primary },
              ]}
            >
              Cancel
            </Text>
          </Pressable>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>
            New report
          </Text>
          <View style={{ width: 50 }} />
        </View>

        <ScrollView
          contentContainerStyle={{
            padding: 20,
            gap: 18,
            paddingBottom: insets.bottom + 40,
          }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Blank report quick start */}
          <View
            style={[
              styles.blankBox,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <Text
              style={[styles.sectionLabel, { color: colors.mutedForeground }]}
            >
              START BLANK
            </Text>
            <TextInput
              value={blankTitle}
              onChangeText={setBlankTitle}
              placeholder="Report title"
              placeholderTextColor={colors.mutedForeground}
              editable={!busy}
              style={[
                styles.titleInput,
                {
                  color: colors.foreground,
                  backgroundColor: colors.background,
                  borderColor: colors.border,
                },
              ]}
            />
            <Button
              title={creatingBlank ? "Creating…" : "Start blank report"}
              loading={creatingBlank}
              disabled={!blankTitle.trim() || busy}
              onPress={() => void createBlank()}
            />
          </View>

          <Text
            style={[styles.sectionLabel, { color: colors.mutedForeground }]}
          >
            OR APPLY A TEMPLATE
          </Text>

          {error ? (
            <Text
              style={{
                color: colors.destructive,
                fontFamily: "Inter_500Medium",
                fontSize: 13,
              }}
            >
              {error}
            </Text>
          ) : null}

          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.mutedForeground} />
            </View>
          ) : templates.length === 0 ? (
            <View style={[styles.center, { padding: 20 }]}>
              <Feather name="layers" size={24} color={colors.mutedForeground} />
              <Text
                style={{
                  color: colors.mutedForeground,
                  fontFamily: "Inter_500Medium",
                  textAlign: "center",
                  marginTop: 10,
                  lineHeight: 18,
                  fontSize: 13,
                }}
              >
                No templates yet. Create one on the web to instantiate from here.
              </Text>
            </View>
          ) : (
            <View style={{ gap: 10 }}>
              {templates.map((t) => {
                const sectionCount = templateSectionCount(t);
                const isPicking = pickingId === String(t.id);
                return (
                  <Pressable
                    key={String(t.id)}
                    disabled={busy}
                    onPress={() => void choose(t)}
                    style={({ pressed }) => [
                      styles.templateCard,
                      {
                        backgroundColor: colors.card,
                        borderColor: colors.border,
                        opacity:
                          busy && !isPicking ? 0.4 : pressed ? 0.85 : 1,
                      },
                    ]}
                  >
                    <View style={{ flex: 1, gap: 4 }}>
                      <Text
                        style={[
                          styles.templateTitle,
                          { color: colors.foreground },
                        ]}
                      >
                        {t.title}
                      </Text>
                      <Text
                        style={{
                          color: colors.mutedForeground,
                          fontSize: 12,
                          fontFamily: "Inter_500Medium",
                        }}
                      >
                        {sectionCount} section{sectionCount === 1 ? "" : "s"}
                      </Text>
                    </View>
                    {isPicking ? (
                      <ActivityIndicator color={colors.primary} />
                    ) : (
                      <Feather
                        name="chevron-right"
                        size={18}
                        color={colors.mutedForeground}
                      />
                    )}
                  </Pressable>
                );
              })}
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
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
  headerBtn: { fontFamily: "Inter_600SemiBold", fontSize: 16 },
  headerTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold" },
  center: { alignItems: "center", justifyContent: "center" },
  sectionLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
  },
  blankBox: {
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    gap: 10,
  },
  titleInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: "Inter_500Medium",
    fontSize: 14,
  },
  templateCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
  },
  templateTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: -0.2,
  },
});
