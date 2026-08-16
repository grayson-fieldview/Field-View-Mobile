import { Feather } from "@expo/vector-icons";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";
import { api } from "@/services/api";
import {
  cancelRecording,
  requestPermission,
  startRecording,
  stopRecording,
} from "@/services/voiceRecording";
import { isModuleUnavailableError } from "@/services/voiceRecordingErrors";

/**
 * Mic → record → transcribe → hand the text to the parent. Mobile
 * analogue of the web voice-note component; standalone so the
 * walkthrough flow can reuse it later.
 *
 * expo-audio caveats (module is loaded DYNAMICALLY inside
 * services/voiceRecording.ts): a dev client that predates expo-audio
 * makes the import throw at first use. That must never crash — the
 * button collapses to a disabled "unavailable" state instead.
 *
 * Timing: the hard cap is ONE absolute setTimeout and the elapsed
 * display derives from wall clock (Date.now() − start), never from
 * tick counting — background throttling makes tick counts drift.
 */

const MAX_RECORDING_MS = 5 * 60 * 1000; // hard cap 5:00 — auto-stop, keep audio
const WARN_AT_MS = 4 * 60 * 1000; // counter turns warning-colored at 4:00
const WARN_COLOR = "#f59e0b";

interface Props {
  onTranscript: (text: string) => void;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
}

// "starting" covers the permission + startRecording awaits: it is
// entered SYNCHRONOUSLY (ref set before the first await) so a second
// tap can never admit a concurrent start, and it counts as busy so the
// parent disables Generate/close-adjacent actions during the window.
type Phase = "idle" | "starting" | "recording" | "transcribing";

export function VoiceNoteButton({ onTranscript, onBusyChange, disabled }: Props) {
  const colors = useColors();
  const [phase, setPhase] = useState<Phase>("idle");
  // now/startedAt exist purely to re-render the counter; the value
  // shown is always wall-clock derived.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [moduleUnavailable, setModuleUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;
  const capTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const displayTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  // Guards double-taps on Stop / cap-timer overlap: stop must run once.
  const stoppingRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (capTimerRef.current) {
      clearTimeout(capTimerRef.current);
      capTimerRef.current = null;
    }
    if (displayTimerRef.current) {
      clearInterval(displayTimerRef.current);
      displayTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    onBusyChange?.(phase !== "idle");
  }, [phase, onBusyChange]);

  // ALWAYS cancel on unmount — releases the native recorder and
  // restores the audio session if we were mid-recording.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimers();
      if (phaseRef.current === "recording") {
        void cancelRecording().catch(() => {});
      }
    };
  }, [clearTimers]);

  const finishRecording = useCallback(async () => {
    if (stoppingRef.current || phaseRef.current !== "recording") return;
    stoppingRef.current = true;
    clearTimers();
    setPhase("transcribing");
    try {
      const { uri, mimeType } = await stopRecording();
      const { transcript } = await api.transcribeAudio(uri, mimeType);
      if (!mountedRef.current) return;
      setPhase("idle");
      setStartedAt(null);
      onTranscript(transcript);
    } catch (e) {
      // stopRecording released the recorder on its own failure path;
      // a transcribe failure has no live recorder. Nothing to cancel.
      if (!mountedRef.current) return;
      setPhase("idle");
      setStartedAt(null);
      setError(
        e instanceof Error && e.message
          ? e.message
          : "Couldn't transcribe the recording.",
      );
    } finally {
      stoppingRef.current = false;
    }
  }, [clearTimers, onTranscript]);

  const beginRecording = useCallback(async () => {
    if (phaseRef.current !== "idle" || disabled) return;
    // SYNCHRONOUS reservation — the ref flips before any await, so a
    // second tap in the permission/start window is rejected above and
    // can never trigger a start (whose failure path used to be able to
    // cancel the first attempt's live recording).
    phaseRef.current = "starting";
    setPhase("starting");
    const bail = (fn?: () => void) => {
      if (mountedRef.current) {
        phaseRef.current = "idle";
        setPhase("idle");
        fn?.();
      }
    };
    setError(null);
    setPermissionDenied(false);
    let granted: boolean;
    try {
      granted = await requestPermission();
    } catch {
      // Dynamic import threw — dev client predates expo-audio.
      bail(() => setModuleUnavailable(true));
      return;
    }
    if (!mountedRef.current) return;
    if (!granted) {
      bail(() => setPermissionDenied(true));
      return;
    }
    try {
      await startRecording();
    } catch (e) {
      // startRecording cleans up after itself on failure (release +
      // audio-mode restore). Deliberately NO global cancelRecording()
      // here: this attempt never acquired the recorder, and a global
      // cancel could kill a recording owned by someone else.
      bail(() => {
        if (isModuleUnavailableError(e)) {
          setModuleUnavailable(true);
        } else {
          setError(
            e instanceof Error && e.message
              ? e.message
              : "Couldn't start recording.",
          );
        }
      });
      return;
    }
    if (!mountedRef.current) {
      // Unmounted while starting — the unmount cleanup already ran and
      // missed this recorder; discard it now.
      void cancelRecording().catch(() => {});
      return;
    }
    const start = Date.now();
    setStartedAt(start);
    setNow(start);
    // Synchronous too — the unmount cleanup keys on phaseRef, and the
    // re-render that syncs it from state hasn't happened yet.
    phaseRef.current = "recording";
    setPhase("recording");
    // Single ABSOLUTE timeout for the cap — auto-stop and transcribe
    // what was captured; never discard.
    capTimerRef.current = setTimeout(() => {
      void finishRecording();
    }, MAX_RECORDING_MS);
    // Display refresh only; elapsed value is wall-clock derived.
    displayTimerRef.current = setInterval(() => {
      setNow(Date.now());
    }, 500);
  }, [disabled, finishRecording]);

  if (moduleUnavailable) {
    // Native module missing in this build — disabled state, no crash.
    return (
      <View style={styles.row}>
        <Feather name="mic-off" size={14} color={colors.mutedForeground} />
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>
          Voice notes need an app update.
        </Text>
      </View>
    );
  }

  const elapsedMs = phase === "recording" && startedAt ? Math.max(0, now - startedAt) : 0;
  const totalSec = Math.floor(elapsedMs / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  const counterColor =
    elapsedMs >= WARN_AT_MS ? WARN_COLOR : colors.mutedForeground;

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        {phase === "recording" ? (
          <>
            <Text
              style={[styles.counter, { color: counterColor }]}
              accessibilityLabel={`Recording, ${mm}:${ss} elapsed`}
            >
              {mm}:{ss}
            </Text>
            <Pressable
              onPress={() => void finishRecording()}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Stop recording"
              style={({ pressed }) => [
                styles.btn,
                {
                  backgroundColor: colors.destructive,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <Feather name="square" size={13} color="#fff" />
              <Text style={styles.btnLabel}>Stop</Text>
            </Pressable>
          </>
        ) : phase === "transcribing" ? (
          <View style={[styles.btn, { backgroundColor: colors.secondary }]}>
            <Feather name="loader" size={13} color={colors.mutedForeground} />
            <Text style={[styles.btnLabel, { color: colors.mutedForeground }]}>
              Transcribing...
            </Text>
          </View>
        ) : (
          <Pressable
            onPress={() => void beginRecording()}
            disabled={disabled || phase === "starting"}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Record a voice note"
            style={({ pressed }) => [
              styles.btn,
              {
                backgroundColor: colors.secondary,
                opacity:
                  disabled || phase === "starting" ? 0.5 : pressed ? 0.85 : 1,
              },
            ]}
          >
            <Feather name="mic" size={13} color={colors.primary} />
            <Text style={[styles.btnLabel, { color: colors.foreground }]}>
              Record
            </Text>
          </Pressable>
        )}
      </View>
      {permissionDenied ? (
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>
          Microphone access is blocked. Enable it in Settings, or type
          instead.
        </Text>
      ) : null}
      {error ? (
        <Text style={[styles.hint, { color: colors.destructive }]}>{error}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 4,
    alignItems: "flex-end",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
  },
  btnLabel: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  counter: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    fontVariant: ["tabular-nums"],
  },
  hint: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    textAlign: "right",
    maxWidth: 240,
  },
});
