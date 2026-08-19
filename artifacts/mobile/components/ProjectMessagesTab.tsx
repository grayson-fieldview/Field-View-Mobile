import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useColors } from "@/hooks/useColors";
import {
  api,
  ApiError,
  type BackendProjectMessage,
  type BackendUser,
} from "@/services/api";

/**
 * MENTION WIRE FORMAT (web-confirmed): content is PLAIN TEXT — the
 * literal composed text with "@FirstName LastName" left as-is, no
 * inline markup. Mentioned ids travel ONLY in the `mentions` array.
 * Rendering shows the body verbatim plus a chip row underneath that
 * maps `msg.mentions` ids to CURRENT names from the candidate list
 * (unresolvable ids get a generic fallback), matching web exactly.
 */
function userDisplayName(u: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string;
}): string {
  return (
    `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email || "Unknown"
  );
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface StagedMention {
  id: number;
  name: string;
}

export function ProjectMessagesTab({
  projectId,
  header,
  onReadMarked,
}: {
  projectId: string;
  header: React.ReactNode;
  /** Fired after a successful mark-read POST so the parent can zero
   *  the tab badge without refetching. */
  onReadMarked?: () => void;
}) {
  const colors = useColors();
  const [messages, setMessages] = useState<BackendProjectMessage[] | null>(
    null,
  );
  const [hasMore, setHasMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [candidates, setCandidates] = useState<BackendUser[]>([]);
  const [text, setText] = useState("");
  const [staged, setStaged] = useState<StagedMention[]>([]);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<ScrollView | null>(null);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  /** Current-name lookup for mention rendering. */
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of candidates) m.set(String(u.id), userDisplayName(u));
    return m;
  }, [candidates]);

  const markRead = useCallback(async () => {
    try {
      await api.markProjectMessagesRead(projectId);
      onReadMarked?.();
    } catch {
      // Non-fatal — the badge just stays until the next successful mark.
    }
  }, [projectId, onReadMarked]);

  // Initial load: newest page + candidates; mark read on open (spec)
  // and again whenever new messages load while the tab is open (the
  // send/refresh paths below call markRead too).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [page, users] = await Promise.all([
          api.listProjectMessages(projectId, { limit: 50 }),
          api.listUsers({ assignableForProjectId: projectId }).catch(
            () => [] as BackendUser[],
          ),
        ]);
        if (cancelled) return;
        setMessages(page.messages);
        setHasMore(page.hasMore);
        setCandidates(users);
        setLoadError(null);
        void markRead();
        requestAnimationFrame(() =>
          scrollRef.current?.scrollToEnd({ animated: false }),
        );
      } catch (e) {
        if (cancelled) return;
        setLoadError(
          e instanceof ApiError && e.message
            ? e.message
            : "Couldn't load messages",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, markRead]);

  const loadOlder = async () => {
    if (loadingOlder || !messages || messages.length === 0) return;
    setLoadingOlder(true);
    try {
      const page = await api.listProjectMessages(projectId, {
        limit: 50,
        before: messages[0].id,
      });
      if (!mountedRef.current) return;
      setMessages((prev) => [...page.messages, ...(prev ?? [])]);
      setHasMore(page.hasMore);
      void markRead();
    } catch (e) {
      if (mountedRef.current) {
        setLoadError(
          e instanceof ApiError && e.message
            ? e.message
            : "Couldn't load older messages",
        );
      }
    } finally {
      if (mountedRef.current) setLoadingOlder(false);
    }
  };

  // ----- Composer + @typeahead -----

  // Active @query: text ends with "@word..." (word = letters/spaces up
  // to 30 chars) preceded by start-of-text or whitespace.
  const mentionQuery = useMemo(() => {
    const m = /(^|\s)@([^\s@]{0,30}(?: [^\s@]{0,30})?)$/.exec(text);
    return m ? m[2] : null;
  }, [text]);

  const typeaheadMatches = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return candidates
      .filter((u) => userDisplayName(u).toLowerCase().includes(q))
      .slice(0, 5);
  }, [mentionQuery, candidates]);

  const pickMention = (u: BackendUser) => {
    const name = userDisplayName(u);
    const id = Number(u.id);
    if (!Number.isFinite(id)) return;
    setText((prev) =>
      prev.replace(/(^|\s)@[^@]*$/, (_m, pre: string) => `${pre}@${name} `),
    );
    setStaged((prev) =>
      prev.some((s) => s.id === id) ? prev : [...prev, { id, name }],
    );
  };

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    if (trimmed.length > 5000) return; // maxLength guards this already
    setSending(true);
    try {
      // Web-confirmed wire shape: content is the LITERAL composed text
      // (plain "@First Last" stays as typed); ids go in `mentions`.
      // Staged ids whose "@Name" token was deleted from the text are
      // pruned so editing away a mention doesn't still notify.
      const mentions = staged
        .filter((s) => trimmed.includes(`@${s.name}`))
        .map((s) => s.id);
      const msg = await api.postProjectMessage(projectId, {
        content: trimmed,
        mentions,
      });
      if (!mountedRef.current) return;
      setMessages((prev) => [...(prev ?? []), msg]);
      setText("");
      setStaged([]);
      void markRead();
      requestAnimationFrame(() =>
        scrollRef.current?.scrollToEnd({ animated: true }),
      );
    } catch (e) {
      if (mountedRef.current) {
        setLoadError(
          e instanceof ApiError && e.message
            ? e.message
            : "Couldn't send message",
        );
      }
    } finally {
      if (mountedRef.current) setSending(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
    >
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, gap: 14 }}
        keyboardShouldPersistTaps="handled"
      >
        {header}
        {loadError ? (
          <Text style={{ color: colors.destructive, fontSize: 13 }}>
            {loadError}
          </Text>
        ) : null}
        {messages === null ? (
          <ActivityIndicator size="small" color={colors.mutedForeground} />
        ) : (
          <>
            {hasMore ? (
              <Pressable
                onPress={() => void loadOlder()}
                disabled={loadingOlder}
                style={{ alignItems: "center", paddingVertical: 4 }}
              >
                {loadingOlder ? (
                  <ActivityIndicator
                    size="small"
                    color={colors.mutedForeground}
                  />
                ) : (
                  <Text
                    style={{
                      color: colors.primary,
                      fontFamily: "Inter_600SemiBold",
                      fontSize: 13,
                    }}
                  >
                    Load earlier messages
                  </Text>
                )}
              </Pressable>
            ) : null}
            {messages.length === 0 ? (
              <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>
                No messages yet. Start the conversation.
              </Text>
            ) : (
              messages.map((m) => {
                const authorName = m.author
                  ? // Author display prefers the CURRENT candidate-list
                    // name when the author is still a candidate.
                    (nameById.get(String(m.author.id)) ??
                    userDisplayName(m.author))
                  : "Unknown";
                const initials =
                  authorName
                    .split(/\s+/)
                    .map((p) => p[0])
                    .filter(Boolean)
                    .slice(0, 2)
                    .join("")
                    .toUpperCase() || "?";
                return (
                  <View key={String(m.id)} style={styles.msgRow}>
                    {m.author?.profileImageUrl ? (
                      <Image
                        source={{ uri: m.author.profileImageUrl }}
                        style={styles.avatar}
                        contentFit="cover"
                      />
                    ) : (
                      <View
                        style={[
                          styles.avatar,
                          {
                            backgroundColor: colors.muted,
                            alignItems: "center",
                            justifyContent: "center",
                          },
                        ]}
                      >
                        <Text
                          style={{
                            color: colors.foreground,
                            fontFamily: "Inter_700Bold",
                            fontSize: 11,
                          }}
                        >
                          {initials}
                        </Text>
                      </View>
                    )}
                    <View style={{ flex: 1, gap: 2 }}>
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "baseline",
                          gap: 8,
                        }}
                      >
                        <Text
                          style={{
                            color: colors.foreground,
                            fontFamily: "Inter_600SemiBold",
                            fontSize: 13,
                          }}
                          numberOfLines={1}
                        >
                          {authorName}
                        </Text>
                        <Text
                          style={{
                            color: colors.mutedForeground,
                            fontSize: 11,
                          }}
                        >
                          {relativeTime(m.createdAt)}
                        </Text>
                      </View>
                      {/* Body renders VERBATIM (web-confirmed: plain
                          text, no inline markup to parse). */}
                      <Text
                        style={{
                          color: colors.foreground,
                          fontSize: 14,
                          lineHeight: 20,
                        }}
                      >
                        {m.content}
                      </Text>
                      {/* Mention chips below the body, ids resolved to
                          CURRENT names; unresolvable ids fall back to a
                          generic label — matching web. */}
                      {m.mentions && m.mentions.length > 0 ? (
                        <View style={styles.chipRow}>
                          {m.mentions.map((uid) => (
                            <View
                              key={String(uid)}
                              style={[
                                styles.chip,
                                { backgroundColor: colors.muted },
                              ]}
                            >
                              <Text
                                style={{
                                  color: colors.primary,
                                  fontFamily: "Inter_600SemiBold",
                                  fontSize: 11,
                                }}
                              >
                                @
                                {nameById.get(String(uid)) ??
                                  "Unknown user"}
                              </Text>
                            </View>
                          ))}
                        </View>
                      ) : null}
                    </View>
                  </View>
                );
              })
            )}
          </>
        )}
      </ScrollView>

      {/* Typeahead sits directly above the composer. */}
      {typeaheadMatches.length > 0 ? (
        <View
          style={[
            styles.typeahead,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          {typeaheadMatches.map((u) => (
            <Pressable
              key={String(u.id)}
              onPress={() => pickMention(u)}
              style={styles.typeaheadRow}
            >
              <Text
                style={{
                  color: colors.foreground,
                  fontFamily: "Inter_500Medium",
                  fontSize: 14,
                }}
              >
                {userDisplayName(u)}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View
        style={[
          styles.composer,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        <TextInput
          style={[
            styles.composerInput,
            { color: colors.foreground, backgroundColor: colors.muted },
          ]}
          placeholder="Message… use @ to mention"
          placeholderTextColor={colors.mutedForeground}
          value={text}
          onChangeText={setText}
          multiline
          maxLength={5000}
        />
        <Pressable
          onPress={() => void send()}
          disabled={sending || !text.trim()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Send message"
          style={{ opacity: sending || !text.trim() ? 0.4 : 1 }}
        >
          {sending ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Feather name="send" size={20} color={colors.primary} />
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  msgRow: {
    flexDirection: "row",
    gap: 10,
    alignItems: "flex-start",
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 4,
  },
  chip: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  typeahead: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  typeaheadRow: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  composerInput: {
    flex: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    maxHeight: 120,
  },
});
