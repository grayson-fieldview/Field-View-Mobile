import {
  BottomSheetBackdrop,
  BottomSheetModal,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import React, { useCallback, useEffect, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ProjectMessagesTab } from "@/components/ProjectMessagesTab";
import { useColors } from "@/hooks/useColors";

const SNAP_MESSAGES = ["85%"];

/**
 * Project messages as a slide-up gorhom sheet (replaces the Messages tab
 * pill — the thread is reached from the floating action cluster now, same
 * presentation pattern as the photo viewer's comments sheet).
 *
 * presentedRef guard: gorhom's dismiss() does not early-exit from
 * MODAL_STATUS.INITIAL — dismissing a never-presented modal wedges it in
 * DISMISSING and blocks the next present(). Only dismiss while presented.
 */
export function ProjectMessagesSheet({
  visible,
  projectId,
  onClose,
  onReadMarked,
}: {
  visible: boolean;
  projectId: string;
  onClose: () => void;
  onReadMarked?: () => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);
  const presentedRef = useRef(false);

  useEffect(() => {
    if (visible) {
      presentedRef.current = true;
      sheetRef.current?.present();
    } else if (presentedRef.current) {
      presentedRef.current = false;
      sheetRef.current?.dismiss();
    }
  }, [visible]);

  const Backdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
      />
    ),
    [],
  );

  return (
    <BottomSheetModal
      ref={sheetRef}
      snapPoints={SNAP_MESSAGES}
      enableDynamicSizing={false}
      enablePanDownToClose
      // The thread + composer manage their own scrolling/keyboard; let
      // the inner ScrollView own content pans (handle still dismisses).
      enableContentPanningGesture={false}
      onDismiss={() => {
        presentedRef.current = false;
        onClose();
      }}
      backdropComponent={Backdrop}
      backgroundStyle={{ backgroundColor: colors.card }}
      handleIndicatorStyle={{ backgroundColor: colors.mutedForeground }}
      keyboardBehavior="extend"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
    >
      <View style={[styles.body, { paddingBottom: insets.bottom }]}>
        <Text style={[styles.title, { color: colors.foreground }]}>
          Messages
        </Text>
        {/* Mount only while visible so the open → mark-read contract
            fires per open, matching the old tab's behavior. */}
        {visible ? (
          <ProjectMessagesTab
            projectId={projectId}
            onReadMarked={onReadMarked}
          />
        ) : null}
      </View>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  title: {
    fontFamily: "Inter_700Bold",
    fontSize: 17,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
});
