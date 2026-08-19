import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import {
  api,
  ApiError,
  type BackendNotification,
} from "@/services/api";

const SNAP_NOTIFICATIONS = ["75%"];

function ClearBackdrop(props: BottomSheetBackdropProps) {
  return (
    <BottomSheetBackdrop
      {...props}
      appearsOnIndex={0}
      disappearsOnIndex={-1}
      opacity={0.4}
      pressBehavior="close"
    />
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
  });
}

function isUnread(n: BackendNotification): boolean {
  // Shape-tolerant: `read` boolean wins; else readAt null/absent = unread.
  if (typeof n.read === "boolean") return !n.read;
  return n.readAt === null || n.readAt === undefined;
}

function actorLabel(n: BackendNotification): string {
  if (n.actor) {
    const name =
      `${n.actor.firstName ?? ""} ${n.actor.lastName ?? ""}`.trim();
    if (name) return name;
  }
  return n.actorName?.trim() || "Someone";
}

function whatHappened(n: BackendNotification): string {
  switch (n.type) {
    case "project_mention":
      return "mentioned you";
    case "task_assigned":
      return "assigned you a task";
    default:
      // Open set — render unknown types generically, never crash.
      return n.body ?? n.message ?? "sent a notification";
  }
}

/**
 * Notification bell sheet (gorhom BottomSheetModal, presentedRef
 * pattern — dismiss() is NEVER called unless present() ran first, per
 * the INITIAL→DISMISSING wedge).
 */
export function NotificationsSheet({
  visible,
  onClose,
  onUnreadChanged,
}: {
  visible: boolean;
  onClose: () => void;
  /** Fired with the new unread count after reads/mark-all. */
  onUnreadChanged?: (unread: number) => void;
}) {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);
  const presentedRef = useRef(false);

  const [items, setItems] = useState<BackendNotification[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);

  useEffect(() => {
    if (visible) {
      presentedRef.current = true;
      sheetRef.current?.present();
    } else if (presentedRef.current) {
      presentedRef.current = false;
      sheetRef.current?.dismiss();
    }
  }, [visible]);

  const reportUnread = useCallback(
    (list: BackendNotification[]) => {
      onUnreadChanged?.(list.filter(isUnread).length);
    },
    [onUnreadChanged],
  );

  // (Re)load first page each open.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setItems(null);
    setLoadError(null);
    api
      .listNotifications({ limit: 50 })
      .then((res) => {
        if (cancelled) return;
        setItems(res.notifications);
        setHasMore(res.hasMore);
        reportUnread(res.notifications);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(
          e instanceof ApiError && e.message
            ? e.message
            : "Couldn't load notifications",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [visible, reportUnread]);

  const loadMore = async () => {
    if (loadingMore || !items || items.length === 0) return;
    setLoadingMore(true);
    try {
      const res = await api.listNotifications({
        limit: 50,
        before: items[items.length - 1].id,
      });
      setItems((prev) => {
        const next = [...(prev ?? []), ...res.notifications];
        reportUnread(next);
        return next;
      });
      setHasMore(res.hasMore);
    } catch {
      /* keep current page; row remains tappable to retry via reopen */
    } finally {
      setLoadingMore(false);
    }
  };

  const markAll = async () => {
    if (markingAll) return;
    setMarkingAll(true);
    try {
      await api.markAllNotificationsRead();
      setItems((prev) => {
        const next = (prev ?? []).map((n) => ({
          ...n,
          read: true,
          readAt: n.readAt ?? new Date().toISOString(),
        }));
        onUnreadChanged?.(0);
        return next;
      });
    } catch {
      /* leave rows as-is */
    } finally {
      setMarkingAll(false);
    }
  };

  const openItem = (n: BackendNotification) => {
    // Server-first not needed here: read-marking a notification is
    // fire-and-forget; navigation shouldn't wait on it.
    if (isUnread(n)) {
      void api.markNotificationRead(n.id).catch(() => {});
      setItems((prev) => {
        const next = (prev ?? []).map((x) =>
          x.id === n.id
            ? { ...x, read: true, readAt: new Date().toISOString() }
            : x,
        );
        reportUnread(next);
        return next;
      });
    }
    onClose();
    if (n.type === "project_mention" && n.projectId != null) {
      router.push({
        pathname: "/project/[id]",
        params: { id: String(n.projectId), tab: "messages" },
      });
    } else if (n.type === "task_assigned" && n.taskId != null) {
      router.push({
        pathname: "/task/[id]",
        params: { id: String(n.taskId) },
      });
    } else if (n.projectId != null) {
      router.push({
        pathname: "/project/[id]",
        params: { id: String(n.projectId) },
      });
    }
  };

  return (
    <BottomSheetModal
      ref={sheetRef}
      snapPoints={SNAP_NOTIFICATIONS}
      enableDynamicSizing={false}
      enablePanDownToClose
      onDismiss={() => {
        presentedRef.current = false;
        onClose();
      }}
      backdropComponent={ClearBackdrop}
      backgroundStyle={{ backgroundColor: colors.card }}
      handleIndicatorStyle={{ backgroundColor: colors.mutedForeground }}
      android_keyboardInputMode="adjustResize"
    >
      <View style={styles.header}>
        <Text
          style={{
            color: colors.foreground,
            fontFamily: "Inter_700Bold",
            fontSize: 17,
            flex: 1,
          }}
        >
          Notifications
        </Text>
        <Pressable
          onPress={() => void markAll()}
          disabled={markingAll || !items?.some(isUnread)}
          hitSlop={8}
        >
          {markingAll ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text
              style={{
                color: colors.primary,
                fontFamily: "Inter_600SemiBold",
                fontSize: 13,
                opacity: items?.some(isUnread) ? 1 : 0.4,
              }}
            >
              Mark all read
            </Text>
          )}
        </Pressable>
      </View>
      <BottomSheetScrollView
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: insets.bottom + 16,
          gap: 10,
        }}
      >
        {loadError ? (
          <Text style={{ color: colors.destructive, fontSize: 13 }}>
            {loadError}
          </Text>
        ) : items === null ? (
          <ActivityIndicator size="small" color={colors.mutedForeground} />
        ) : items.length === 0 ? (
          <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>
            You're all caught up.
          </Text>
        ) : (
          items.map((n) => {
            const unread = isUnread(n);
            return (
              <Pressable
                key={String(n.id)}
                onPress={() => openItem(n)}
                style={[
                  styles.row,
                  {
                    backgroundColor: unread
                      ? colors.muted
                      : colors.background,
                    borderColor: colors.border,
                  },
                ]}
              >
                {unread ? (
                  <View
                    style={[
                      styles.unreadDot,
                      { backgroundColor: colors.primary },
                    ]}
                  />
                ) : (
                  <View style={styles.unreadDot} />
                )}
                <View style={{ flex: 1, gap: 2 }}>
                  <Text
                    style={{
                      color: colors.foreground,
                      fontSize: 13,
                      lineHeight: 18,
                      fontFamily: unread
                        ? "Inter_600SemiBold"
                        : "Inter_400Regular",
                    }}
                  >
                    {actorLabel(n)} {whatHappened(n)}
                  </Text>
                  <Text
                    style={{ color: colors.mutedForeground, fontSize: 11 }}
                    numberOfLines={1}
                  >
                    {[n.projectName, relativeTime(n.createdAt)]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
                <Feather
                  name="chevron-right"
                  size={16}
                  color={colors.mutedForeground}
                />
              </Pressable>
            );
          })
        )}
        {hasMore ? (
          <Pressable
            onPress={() => void loadMore()}
            disabled={loadingMore}
            style={{ alignItems: "center", paddingVertical: 8 }}
          >
            {loadingMore ? (
              <ActivityIndicator size="small" color={colors.mutedForeground} />
            ) : (
              <Text
                style={{
                  color: colors.primary,
                  fontFamily: "Inter_600SemiBold",
                  fontSize: 13,
                }}
              >
                Load more
              </Text>
            )}
          </Pressable>
        ) : null}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 10,
    gap: 12,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
