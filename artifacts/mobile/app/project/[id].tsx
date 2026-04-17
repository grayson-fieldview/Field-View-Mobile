import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/Input";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useData } from "@/contexts/DataContext";
import { useColors } from "@/hooks/useColors";

type TabKey = "photos" | "tasks" | "checklists" | "team";

export default function ProjectDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const {
    projects,
    photos,
    tasks,
    checklists,
    shares,
    deleteProject,
    createTask,
    toggleTask,
    deleteTask,
    createChecklist,
    toggleChecklistItem,
    deleteChecklist,
    createShare,
    revokeShare,
    deletePhoto,
    loadProjectDetail,
  } = useData();

  // When opening a project that originated from the backend, pull its latest
  // photos / tasks / checklists so the tabs aren't empty.
  useEffect(() => {
    if (id) loadProjectDetail(String(id));
  }, [id, loadProjectDetail]);

  const project = useMemo(
    () => projects.find((p) => p.id === id),
    [projects, id],
  );
  const projectPhotos = useMemo(
    () => photos.filter((p) => p.projectId === id),
    [photos, id],
  );
  const projectTasks = useMemo(
    () => tasks.filter((t) => t.projectId === id),
    [tasks, id],
  );
  const projectChecklists = useMemo(
    () => checklists.filter((c) => c.projectId === id),
    [checklists, id],
  );
  const projectShares = useMemo(
    () => shares.filter((s) => s.projectId === id),
    [shares, id],
  );

  const [tab, setTab] = useState<TabKey>("photos");
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [showChecklistModal, setShowChecklistModal] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);

  // Photos tab UI state.
  const [gridSize, setGridSize] = useState<1 | 2 | 3>(2);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Selection mode is implicit: we're in it whenever something is selected.
  const selectMode = selected.size > 0;

  // Group photos by their taken-at calendar day, most recent day first; within
  // each day, photos are sorted with the newest at the top.
  const photoGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        label: string;
        sortKey: number;
        ids: string[];
        photos: typeof projectPhotos;
      }
    >();
    for (const ph of projectPhotos) {
      const d = ph.takenAt ? new Date(ph.takenAt) : new Date();
      const dayStart = new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
      ).getTime();
      const dayKey = String(dayStart);
      const label = d.toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
      const g =
        groups.get(dayKey) ??
        { label, sortKey: dayStart, ids: [], photos: [] };
      g.ids.push(ph.id);
      g.photos.push(ph);
      groups.set(dayKey, g);
    }
    const list = Array.from(groups.values());
    for (const g of list) {
      g.photos.sort((a, b) => {
        const ta = a.takenAt ? Date.parse(a.takenAt) : 0;
        const tb = b.takenAt ? Date.parse(b.takenAt) : 0;
        return tb - ta;
      });
      g.ids = g.photos.map((p) => p.id);
    }
    return list.sort((a, b) => b.sortKey - a.sortKey);
  }, [projectPhotos]);

  const exitSelectMode = () => {
    setSelected(new Set());
  };

  const onSharePhotos = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    // Build a viewer URL pointing at the production web app. The query string
    // lets the web app filter to just the picked photos.
    const url = `https://code-genius-graysongladu.replit.app/share/project/${project!.id}?photos=${ids.join(",")}`;
    try {
      await Share.share(
        {
          url,
          message: `${project!.name} — ${ids.length} photo${ids.length === 1 ? "" : "s"}\n${url}`,
        },
        { subject: `${project!.name} — Field View photos` },
      );
    } catch {
      /* user cancelled */
    }
  };

  const togglePhotoSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleGroupSelected = (ids: string[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = ids.every((i) => next.has(i));
      if (allSelected) for (const i of ids) next.delete(i);
      else for (const i of ids) next.add(i);
      return next;
    });
  };

  const deleteSelected = () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const doIt = async () => {
      for (const pid of ids) await deletePhoto(pid);
      exitSelectMode();
    };
    if (Platform.OS === "web") return doIt();
    Alert.alert(
      `Delete ${ids.length} photo${ids.length === 1 ? "" : "s"}?`,
      undefined,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: doIt },
      ],
    );
  };

  if (!project) {
    return (
      <View style={[styles.wrap, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: "Project" }} />
        <EmptyState
          icon="alert-triangle"
          title="Project not found"
          description="This project may have been deleted."
        />
      </View>
    );
  }

  const onDelete = () => {
    const doIt = () =>
      deleteProject(project.id).then(() => router.back());
    if (Platform.OS === "web") {
      doIt();
      return;
    }
    Alert.alert(
      "Delete project?",
      `"${project.name}" and all its photos, tasks, and checklists will be removed.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: doIt },
      ],
    );
  };

  const heroPhoto = project.coverPhotoUrl ?? projectPhotos[0]?.uri;
  const status = (project.status ?? "active").toLowerCase();
  const statusColor =
    status === "active"
      ? colors.primary
      : status === "complete" || status === "completed"
        ? colors.success
        : colors.mutedForeground;
  const doneTaskCount = projectTasks.filter((t) => t.done).length;
  const donePct =
    projectTasks.length === 0
      ? 0
      : Math.round((doneTaskCount / projectTasks.length) * 100);
  const totalPhotos =
    typeof project.photoCount === "number" && project.photoCount >= projectPhotos.length
      ? project.photoCount
      : projectPhotos.length;
  const createdLabel = project.createdAt
    ? new Date(project.createdAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <View style={[styles.wrap, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <ScrollView
        contentContainerStyle={{
          paddingBottom: insets.bottom + 100,
        }}
      >
        <View style={styles.heroWrap}>
          {heroPhoto ? (
            <Image
              source={{ uri: heroPhoto }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              transition={150}
            />
          ) : (
            <View
              style={[
                StyleSheet.absoluteFill,
                {
                  backgroundColor: colors.muted,
                  alignItems: "center",
                  justifyContent: "center",
                },
              ]}
            >
              <Feather
                name="image"
                size={36}
                color={colors.mutedForeground}
              />
            </View>
          )}
          <View style={[styles.heroScrim, { paddingTop: insets.top + 8 }]}>
            <Pressable
              onPress={() => router.back()}
              hitSlop={10}
              style={styles.heroBackBtn}
            >
              <Feather name="chevron-left" size={18} color="#fff" />
              <Text style={styles.heroBackTxt}>Projects</Text>
            </Pressable>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {selected.size > 0 ? (
                <Pressable
                  onPress={onSharePhotos}
                  hitSlop={10}
                  accessibilityLabel={`Share ${selected.size} selected photo${selected.size === 1 ? "" : "s"}`}
                  style={styles.heroIconBtn}
                >
                  <Feather name="share-2" size={16} color="#fff" />
                </Pressable>
              ) : null}
              <Pressable
                onPress={onDelete}
                hitSlop={10}
                accessibilityLabel="More options"
                style={styles.heroIconBtn}
              >
                <Feather name="more-horizontal" size={18} color="#fff" />
              </Pressable>
            </View>
          </View>
        </View>

        <View
          style={[
            styles.summaryCard,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <View style={styles.summaryTitleRow}>
            <Text
              style={[styles.summaryTitle, { color: colors.foreground }]}
              numberOfLines={2}
            >
              {project.name}
            </Text>
            <View
              style={[
                styles.statusPill,
                { backgroundColor: statusColor + "22" },
              ]}
            >
              <View
                style={[styles.statusDot, { backgroundColor: statusColor }]}
              />
              <Text
                style={[styles.statusText, { color: statusColor }]}
                numberOfLines={1}
              >
                {(project.status ?? "active").toString()}
              </Text>
            </View>
          </View>

          {project.address ? (
            <View style={styles.summaryMetaRow}>
              <Feather
                name="map-pin"
                size={13}
                color={colors.mutedForeground}
              />
              <Text
                style={[
                  styles.summaryMeta,
                  { color: colors.foreground },
                ]}
                numberOfLines={2}
              >
                {project.address}
              </Text>
            </View>
          ) : null}

          {createdLabel ? (
            <View style={styles.summaryMetaRow}>
              <Feather
                name="calendar"
                size={13}
                color={colors.mutedForeground}
              />
              <Text
                style={[
                  styles.summaryMeta,
                  { color: colors.mutedForeground },
                ]}
              >
                {createdLabel}
              </Text>
            </View>
          ) : null}

          <View style={[styles.statsRow, { borderTopColor: colors.border }]}>
            <View style={styles.statCol}>
              <Text style={[styles.statNum, { color: colors.primary }]}>
                {totalPhotos}
              </Text>
              <Text
                style={[styles.statLbl, { color: colors.mutedForeground }]}
              >
                PHOTOS
              </Text>
            </View>
            <View
              style={[
                styles.statDivider,
                { backgroundColor: colors.border },
              ]}
            />
            <View style={styles.statCol}>
              <Text
                style={[styles.statNum, { color: colors.foreground }]}
              >
                {projectTasks.length}
              </Text>
              <Text
                style={[styles.statLbl, { color: colors.mutedForeground }]}
              >
                TASKS
              </Text>
            </View>
            <View
              style={[
                styles.statDivider,
                { backgroundColor: colors.border },
              ]}
            />
            <View style={styles.statCol}>
              <Text style={[styles.statNum, { color: colors.success }]}>
                {donePct}%
              </Text>
              <Text
                style={[styles.statLbl, { color: colors.mutedForeground }]}
              >
                DONE
              </Text>
            </View>
          </View>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.pillTabsRow}
        >
          {(
            [
              { key: "photos", label: "Photos", count: projectPhotos.length },
              { key: "tasks", label: "Tasks", count: projectTasks.length },
              {
                key: "checklists",
                label: "Checklists",
                count: projectChecklists.length,
              },
              { key: "team", label: "Team", count: projectShares.length },
            ] as { key: TabKey; label: string; count: number }[]
          ).map((t) => {
            const active = tab === t.key;
            return (
              <Pressable
                key={t.key}
                onPress={() => setTab(t.key)}
                style={[
                  styles.pillTab,
                  {
                    backgroundColor: active ? colors.muted : "transparent",
                  },
                ]}
              >
                <Text
                  style={[
                    styles.pillTabLabel,
                    {
                      color: active
                        ? colors.foreground
                        : colors.mutedForeground,
                      fontFamily: active
                        ? "Inter_700Bold"
                        : "Inter_500Medium",
                    },
                  ]}
                >
                  {t.label}
                </Text>
                <Text
                  style={[
                    styles.pillTabCount,
                    {
                      color: active
                        ? colors.mutedForeground
                        : colors.mutedForeground,
                    },
                  ]}
                >
                  {t.count}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {tab === "photos" ? (
          <View style={styles.body}>
            <PhotosToolbar
              gridSize={gridSize}
              onGridSize={setGridSize}
              onTakePhoto={() =>
                router.push({
                  pathname: "/capture",
                  params: { projectId: project.id },
                })
              }
              colors={colors}
            />

            {projectPhotos.length === 0 ? (
              <View style={{ paddingTop: 20 }}>
                <EmptyState
                  icon="camera"
                  title="No photos yet"
                  description="Tap Take Photo to capture burst-mode photos with GPS tagging."
                />
              </View>
            ) : (
              <View style={{ marginTop: 14, gap: 18 }}>
                {photoGroups.map((g) => {
                  const allSelected = g.ids.every((i) => selected.has(i));
                  return (
                    <View key={g.label} style={{ gap: 10 }}>
                      <View style={styles.dateHeader}>
                        <Pressable
                          onPress={() => toggleGroupSelected(g.ids)}
                          hitSlop={6}
                          accessibilityRole="checkbox"
                          accessibilityLabel={`Select all photos from ${g.label}`}
                          accessibilityState={{ checked: allSelected }}
                          style={[
                            styles.dateCheckbox,
                            {
                              borderColor: allSelected
                                ? colors.primary
                                : colors.border,
                              backgroundColor: allSelected
                                ? colors.primary
                                : "transparent",
                            },
                          ]}
                        >
                          {allSelected ? (
                            <Feather
                              name="check"
                              size={12}
                              color={colors.primaryForeground}
                            />
                          ) : null}
                        </Pressable>
                        <Text
                          style={[
                            styles.dateLabel,
                            { color: colors.foreground },
                          ]}
                        >
                          {g.label}
                        </Text>
                      </View>
                      <View
                        style={[
                          styles.photoGrid,
                          gridSize === 1
                            ? { rowGap: 12 }
                            : gridSize === 3
                              ? { rowGap: 6 }
                              : { rowGap: 10 },
                        ]}
                      >
                        {g.photos.map((ph) => (
                          <PhotoTile
                            key={ph.id}
                            photo={ph}
                            borderColor={colors.border}
                            widthPercent={
                              gridSize === 1
                                ? "100%"
                                : gridSize === 2
                                  ? "48.5%"
                                  : "32%"
                            }
                            selectMode={selectMode}
                            selected={selected.has(ph.id)}
                            primary={colors.primary}
                            primaryForeground={colors.primaryForeground}
                            onOpen={() => router.push(`/photo/${ph.id}`)}
                            onToggleSelected={() => togglePhotoSelected(ph.id)}
                            onDelete={() => deletePhoto(ph.id)}
                          />
                        ))}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}

            {selectMode && selected.size > 0 ? (
              <View style={styles.selectionBar}>
                <Pressable onPress={exitSelectMode} hitSlop={6}>
                  <Text
                    style={{
                      color: colors.mutedForeground,
                      fontFamily: "Inter_600SemiBold",
                      fontSize: 14,
                    }}
                  >
                    Cancel
                  </Text>
                </Pressable>
                <Text
                  style={{
                    color: colors.foreground,
                    fontFamily: "Inter_600SemiBold",
                    fontSize: 14,
                  }}
                >
                  {selected.size} selected
                </Text>
                <Pressable onPress={deleteSelected} hitSlop={6}>
                  <Text
                    style={{
                      color: colors.destructive,
                      fontFamily: "Inter_700Bold",
                      fontSize: 14,
                    }}
                  >
                    Delete
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : null}

        {tab === "tasks" ? (
          <View style={styles.body}>
            {projectTasks.length === 0 ? (
              <EmptyState
                icon="check-square"
                title="No tasks yet"
                description="Create tasks to track open items on this project."
                action={
                  <Button
                    title="Add task"
                    onPress={() => setShowTaskModal(true)}
                  />
                }
              />
            ) : (
              <View style={{ gap: 8 }}>
                {projectTasks.map((t) => (
                  <Pressable
                    key={t.id}
                    onPress={() => toggleTask(t.id)}
                    onLongPress={() => {
                      if (Platform.OS === "web") return deleteTask(t.id);
                      Alert.alert("Delete task?", undefined, [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Delete",
                          style: "destructive",
                          onPress: () => deleteTask(t.id),
                        },
                      ]);
                    }}
                    style={[
                      styles.taskRow,
                      {
                        backgroundColor: colors.card,
                        borderColor: colors.border,
                      },
                    ]}
                  >
                    <View
                      style={[
                        styles.checkbox,
                        {
                          borderColor: t.done ? colors.primary : colors.border,
                          backgroundColor: t.done
                            ? colors.primary
                            : "transparent",
                        },
                      ]}
                    >
                      {t.done ? (
                        <Feather
                          name="check"
                          size={14}
                          color={colors.primaryForeground}
                        />
                      ) : null}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text
                        style={[
                          styles.taskTitle,
                          {
                            color: t.done
                              ? colors.mutedForeground
                              : colors.foreground,
                            textDecorationLine: t.done
                              ? "line-through"
                              : "none",
                          },
                        ]}
                      >
                        {t.title}
                      </Text>
                      {t.notes ? (
                        <Text
                          style={[
                            styles.taskNotes,
                            { color: colors.mutedForeground },
                          ]}
                          numberOfLines={2}
                        >
                          {t.notes}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                ))}
                <Button
                  title="Add task"
                  variant="secondary"
                  onPress={() => setShowTaskModal(true)}
                />
              </View>
            )}
          </View>
        ) : null}

        {tab === "checklists" ? (
          <View style={styles.body}>
            {projectChecklists.length === 0 ? (
              <EmptyState
                icon="list"
                title="No checklists yet"
                description="Build repeatable checklists for site walks and handoffs."
                action={
                  <Button
                    title="New checklist"
                    onPress={() => setShowChecklistModal(true)}
                  />
                }
              />
            ) : (
              <View style={{ gap: 14 }}>
                {projectChecklists.map((c) => {
                  const done = c.items.filter((i) => i.done).length;
                  return (
                    <View
                      key={c.id}
                      style={[
                        styles.checklistCard,
                        {
                          backgroundColor: colors.card,
                          borderColor: colors.border,
                        },
                      ]}
                    >
                      <View style={styles.checklistHeader}>
                        <Text
                          style={[
                            styles.checklistTitle,
                            { color: colors.foreground },
                          ]}
                        >
                          {c.title}
                        </Text>
                        <Text
                          style={[
                            styles.checklistMeta,
                            { color: colors.mutedForeground },
                          ]}
                        >
                          {done}/{c.items.length}
                        </Text>
                      </View>
                      <View style={{ gap: 6 }}>
                        {c.items.map((item) => (
                          <Pressable
                            key={item.id}
                            onPress={() => toggleChecklistItem(c.id, item.id)}
                            style={styles.checklistItemRow}
                          >
                            <View
                              style={[
                                styles.checkboxSmall,
                                {
                                  borderColor: item.done
                                    ? colors.primary
                                    : colors.border,
                                  backgroundColor: item.done
                                    ? colors.primary
                                    : "transparent",
                                },
                              ]}
                            >
                              {item.done ? (
                                <Feather
                                  name="check"
                                  size={11}
                                  color={colors.primaryForeground}
                                />
                              ) : null}
                            </View>
                            <Text
                              style={[
                                styles.checklistItemText,
                                {
                                  color: item.done
                                    ? colors.mutedForeground
                                    : colors.foreground,
                                  textDecorationLine: item.done
                                    ? "line-through"
                                    : "none",
                                },
                              ]}
                            >
                              {item.text}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                      <Pressable
                        onPress={() => {
                          if (Platform.OS === "web")
                            return deleteChecklist(c.id);
                          Alert.alert("Delete checklist?", undefined, [
                            { text: "Cancel", style: "cancel" },
                            {
                              text: "Delete",
                              style: "destructive",
                              onPress: () => deleteChecklist(c.id),
                            },
                          ]);
                        }}
                        style={{ alignSelf: "flex-end", paddingTop: 8 }}
                      >
                        <Text
                          style={{
                            color: colors.mutedForeground,
                            fontFamily: "Inter_500Medium",
                            fontSize: 13,
                          }}
                        >
                          Delete
                        </Text>
                      </Pressable>
                    </View>
                  );
                })}
                <Button
                  title="New checklist"
                  variant="secondary"
                  onPress={() => setShowChecklistModal(true)}
                />
              </View>
            )}
          </View>
        ) : null}

        {tab === "team" ? (
          <View style={styles.body}>
            {projectShares.length === 0 ? (
              <EmptyState
                icon="users"
                title="No team members yet"
                description="Invite a teammate or client by email to give them access to this project."
                action={
                  <Button
                    title="Add user"
                    onPress={() => setShowShareModal(true)}
                  />
                }
              />
            ) : (
              <View style={{ gap: 10 }}>
                <Text
                  style={{
                    color: colors.mutedForeground,
                    fontSize: 12,
                    fontFamily: "Inter_500Medium",
                    textTransform: "uppercase",
                    letterSpacing: 1,
                    marginBottom: 2,
                  }}
                >
                  Has access ({projectShares.length})
                </Text>
                {projectShares.map((s) => {
                  const initials = s.recipientEmail
                    .split("@")[0]
                    .split(/[._-]+/)
                    .filter(Boolean)
                    .slice(0, 2)
                    .map((p) => p[0]?.toUpperCase() ?? "")
                    .join("");
                  return (
                    <View
                      key={s.id}
                      style={[
                        styles.shareCard,
                        {
                          backgroundColor: colors.card,
                          borderColor: colors.border,
                        },
                      ]}
                    >
                      <View
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 18,
                          backgroundColor: colors.muted,
                          alignItems: "center",
                          justifyContent: "center",
                          marginRight: 10,
                        }}
                      >
                        <Text
                          style={{
                            color: colors.foreground,
                            fontFamily: "Inter_700Bold",
                            fontSize: 13,
                          }}
                        >
                          {initials || "?"}
                        </Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text
                          style={[
                            styles.shareEmail,
                            { color: colors.foreground },
                          ]}
                          numberOfLines={1}
                        >
                          {s.recipientEmail}
                        </Text>
                        <Text
                          style={[
                            styles.shareUrl,
                            { color: colors.mutedForeground },
                          ]}
                          numberOfLines={1}
                        >
                          Can view photos, tasks &amp; checklists
                        </Text>
                      </View>
                      <Pressable
                        onPress={() => revokeShare(s.id)}
                        hitSlop={10}
                        accessibilityLabel={`Remove ${s.recipientEmail}`}
                      >
                        <Feather
                          name="x"
                          size={18}
                          color={colors.mutedForeground}
                        />
                      </Pressable>
                    </View>
                  );
                })}
                <Button
                  title="Add user"
                  variant="secondary"
                  icon={
                    <Feather
                      name="user-plus"
                      size={14}
                      color={colors.foreground}
                    />
                  }
                  onPress={() => setShowShareModal(true)}
                />
              </View>
            )}
          </View>
        ) : null}
      </ScrollView>

      <TaskModal
        visible={showTaskModal}
        onClose={() => setShowTaskModal(false)}
        onSubmit={async (title, notes, assignee) => {
          await createTask(project.id, title, notes, assignee);
          setShowTaskModal(false);
        }}
      />
      <ChecklistModal
        visible={showChecklistModal}
        onClose={() => setShowChecklistModal(false)}
        onSubmit={async (title, items) => {
          await createChecklist(project.id, title, items);
          setShowChecklistModal(false);
        }}
      />
      <ShareModal
        visible={showShareModal}
        onClose={() => setShowShareModal(false)}
        onSubmit={async (email) => {
          await createShare(project.id, email);
          setShowShareModal(false);
        }}
      />
    </View>
  );
}

function PhotoTile({
  photo,
  borderColor,
  widthPercent,
  selectMode,
  selected,
  primary,
  primaryForeground,
  onOpen,
  onToggleSelected,
  onDelete,
}: {
  photo: import("@/services/types").Photo;
  borderColor: string;
  widthPercent: import("react-native").DimensionValue;
  selectMode: boolean;
  selected: boolean;
  primary: string;
  primaryForeground: string;
  onOpen: () => void;
  onToggleSelected: () => void;
  onDelete: () => void;
}) {
  // Suppress the onPress that fires when a long-press releases.
  const longPressed = useRef(false);

  const handleLongPress = () => {
    if (selectMode) return;
    longPressed.current = true;
    if (Platform.OS === "web") {
      onDelete();
      return;
    }
    Alert.alert("Delete photo?", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: onDelete },
    ]);
  };

  const handlePress = () => {
    if (longPressed.current) {
      longPressed.current = false;
      return;
    }
    if (selectMode) onToggleSelected();
    else onOpen();
  };

  return (
    <Pressable
      accessibilityLabel={
        selectMode
          ? `Photo. ${selected ? "Selected" : "Not selected"}. Tap to toggle.`
          : "Photo. Tap to open, long press to delete."
      }
      accessibilityRole={selectMode ? "checkbox" : "imagebutton"}
      accessibilityState={selectMode ? { checked: selected } : undefined}
      onPress={handlePress}
      onLongPress={handleLongPress}
      delayLongPress={350}
      style={[
        styles.photoTile,
        {
          borderColor: selectMode && selected ? primary : borderColor,
          borderWidth: selectMode && selected ? 3 : 1,
          width: widthPercent,
        },
      ]}
    >
      <Image
        source={{ uri: photo.uri }}
        style={styles.photo}
        contentFit="cover"
        transition={120}
      />
      {selectMode ? (
        <View
          style={[
            styles.selectMark,
            {
              backgroundColor: selected ? primary : "rgba(255,255,255,0.85)",
              borderColor: selected ? primary : "rgba(0,0,0,0.2)",
            },
          ]}
        >
          {selected ? (
            <Feather name="check" size={12} color={primaryForeground} />
          ) : null}
        </View>
      ) : null}
      {photo.latitude != null ? (
        <View style={styles.photoBadge}>
          <Feather name="map-pin" size={10} color="#fff" />
        </View>
      ) : null}
      {photo.annotations && photo.annotations.length > 0 ? (
        <View style={[styles.photoBadge, { right: 6, left: undefined }]}>
          <Feather name="edit-2" size={10} color="#fff" />
        </View>
      ) : null}
    </Pressable>
  );
}

function PhotosToolbar({
  gridSize,
  onGridSize,
  onTakePhoto,
  colors,
}: {
  gridSize: 1 | 2 | 3;
  onGridSize: (s: 1 | 2 | 3) => void;
  onTakePhoto: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={styles.photosToolbar}>
      <View
        style={[
          styles.gridSegment,
          { backgroundColor: colors.muted, borderColor: colors.border },
        ]}
      >
        {([3, 2, 1] as const).map((s) => {
          const active = gridSize === s;
          const icon: keyof typeof Feather.glyphMap =
            s === 3 ? "grid" : s === 2 ? "columns" : "square";
          return (
            <Pressable
              key={s}
              onPress={() => onGridSize(s)}
              accessibilityRole="button"
              accessibilityLabel={`${s}-column grid`}
              accessibilityState={{ selected: active }}
              style={[
                styles.gridBtn,
                {
                  backgroundColor: active
                    ? colors.background
                    : "transparent",
                },
              ]}
            >
              <Feather
                name={icon}
                size={16}
                color={active ? colors.foreground : colors.mutedForeground}
              />
            </Pressable>
          );
        })}
      </View>

      <Pressable
        onPress={onTakePhoto}
        accessibilityRole="button"
        accessibilityLabel="Take photo"
        style={({ pressed }) => [
          styles.toolbarBtnPrimary,
          {
            backgroundColor: colors.primary,
            opacity: pressed ? 0.9 : 1,
          },
        ]}
      >
        <Feather name="camera" size={14} color={colors.primaryForeground} />
        <Text
          style={[
            styles.toolbarBtnText,
            { color: colors.primaryForeground },
          ]}
          numberOfLines={1}
        >
          Take Photo
        </Text>
      </Pressable>
    </View>
  );
}

function TaskModal({
  visible,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmit: (title: string, notes?: string, assignee?: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [assignee, setAssignee] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await onSubmit(title, notes, assignee);
      setTitle("");
      setNotes("");
      setAssignee("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <ModalShell title="New task" onClose={onClose}>
        <Input label="Title" value={title} onChangeText={setTitle} autoFocus />
        <Input
          label="Assigned to"
          value={assignee}
          onChangeText={setAssignee}
          placeholder="Teammate name (optional)"
          autoCapitalize="words"
        />
        <Input
          label="Notes"
          value={notes}
          onChangeText={setNotes}
          multiline
          style={{ minHeight: 80, textAlignVertical: "top" }}
        />
        <Button title="Add task" onPress={save} loading={saving} size="lg" />
      </ModalShell>
    </Modal>
  );
}

function ChecklistModal({
  visible,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmit: (title: string, items: string[]) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [raw, setRaw] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const items = raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      await onSubmit(title, items);
      setTitle("");
      setRaw("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <ModalShell title="New checklist" onClose={onClose}>
        <Input label="Title" value={title} onChangeText={setTitle} autoFocus />
        <Input
          label="Items (one per line)"
          value={raw}
          onChangeText={setRaw}
          multiline
          style={{ minHeight: 140, textAlignVertical: "top" }}
          placeholder={"Verify framing\nCheck insulation\nPhotograph electrical"}
        />
        <Button title="Create checklist" onPress={save} loading={saving} size="lg" />
      </ModalShell>
    </Modal>
  );
}

function ShareModal({
  visible,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmit: (email: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    setSaving(true);
    try {
      await onSubmit(email);
      setEmail("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <ModalShell title="Share with client" onClose={onClose}>
        <Input
          label="Client email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoFocus
          error={error}
        />
        <Button title="Create share link" onPress={save} loading={saving} size="lg" />
      </ModalShell>
    </Modal>
  );
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View
        style={[
          styles.modalHeader,
          {
            paddingTop: insets.top + 8,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <Pressable onPress={onClose} hitSlop={10}>
          <Text style={{ color: colors.primary, fontFamily: "Inter_600SemiBold", fontSize: 16 }}>
            Cancel
          </Text>
        </Pressable>
        <Text style={[styles.modalTitle, { color: colors.foreground }]}>{title}</Text>
        <View style={{ width: 50 }} />
      </View>
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={{
          padding: 20,
          gap: 14,
          paddingBottom: insets.bottom + 40,
        }}
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  heroWrap: {
    width: "100%",
    height: 220,
    backgroundColor: "#000",
  },
  heroScrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  heroBackBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingLeft: 6,
    paddingRight: 12,
    paddingVertical: 8,
    backgroundColor: "rgba(0,0,0,0.45)",
    borderRadius: 100,
  },
  heroBackTxt: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  heroIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  summaryCard: {
    marginTop: -28,
    marginHorizontal: 16,
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    gap: 10,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  summaryTitleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  summaryTitle: {
    flex: 1,
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.4,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 100,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    textTransform: "capitalize",
  },
  summaryMetaRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  summaryMeta: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    lineHeight: 18,
  },
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
    marginTop: 4,
  },
  statCol: { flex: 1, alignItems: "flex-start" },
  statNum: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.5,
  },
  statLbl: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    marginTop: 2,
  },
  statDivider: { width: StyleSheet.hairlineWidth, height: 32 },
  pillTabsRow: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6,
    gap: 8,
  },
  pillTab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 100,
  },
  pillTabLabel: { fontSize: 14 },
  pillTabCount: { fontSize: 12, fontFamily: "Inter_500Medium" },
  tabs: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
  },
  tab: {
    paddingHorizontal: 10,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  body: { padding: 20 },
  photoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: 10,
  },
  photoTile: {
    aspectRatio: 1,
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    position: "relative",
  },
  photosToolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  gridSegment: {
    flexDirection: "row",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 2,
    gap: 2,
  },
  gridBtn: {
    width: 34,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  toolbarBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 36,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
  },
  toolbarBtnPrimary: {
    flex: 1.2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 36,
    borderRadius: 10,
    paddingHorizontal: 12,
  },
  toolbarBtnText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  dateHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  dateCheckbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  dateLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  selectMark: {
    position: "absolute",
    top: 8,
    left: 8,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  selectionBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 18,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.06)",
  },
  photo: { width: "100%", height: "100%" },
  photoBadge: {
    position: "absolute",
    bottom: 6,
    left: 6,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  taskRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxSmall: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  taskTitle: { fontSize: 15, fontFamily: "Inter_500Medium" },
  taskNotes: { fontSize: 13, fontFamily: "Inter_400Regular", marginTop: 2 },
  checklistCard: {
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
  },
  checklistHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  checklistTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold" },
  checklistMeta: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.5,
  },
  checklistItemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 4,
  },
  checklistItemText: { flex: 1, fontSize: 14, fontFamily: "Inter_500Medium" },
  shareCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    gap: 10,
  },
  shareEmail: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  shareUrl: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold" },
});
