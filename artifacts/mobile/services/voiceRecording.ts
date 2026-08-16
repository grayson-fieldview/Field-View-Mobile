/**
 * Voice-note recording service — thin wrapper around expo-audio, no UI.
 *
 * Output format: RecordingPresets.HIGH_QUALITY → `.m4a` (MPEG-4
 * container, AAC encoder) on BOTH platforms — iOS via
 * IOSOutputFormat.MPEG4AAC, Android via outputFormat "mpeg4" +
 * audioEncoder "aac". Reported as `audio/mp4`, which is on the
 * /api/transcribe allowlist (audio/webm | audio/mp4 | audio/ogg).
 *
 * Dynamic-import discipline (see services/appleIap.ts): expo-audio is
 * a NATIVE module. Only type-only imports at module scope — the
 * runtime module is `await import()`ed inside each function so a dev
 * client built before expo-audio existed doesn't crash at bundle eval.
 *
 * Audio-session hygiene: recording mode is set on start and RESTORED
 * on every exit path (stop, cancel, error) — on iOS an unrestored
 * recording session leaves app audio in a bad state. The recorder is
 * likewise released on every exit path.
 */

// Type-only — erased at compile time; safe at module scope.
import type { AudioRecorder } from "expo-audio";

export interface VoiceRecordingResult {
  uri: string;
  mimeType: string;
  durationMs: number;
}

/** MIME type of what the HIGH_QUALITY preset produces on iOS AND Android. */
export const VOICE_RECORDING_MIME_TYPE = "audio/mp4";

// One recording at a time; module-level so cancel/stop can always
// reach the live recorder regardless of caller state.
let activeRecorder: AudioRecorder | null = null;
// Synchronous reservation flag: startRecording awaits several times
// before activeRecorder is assigned, so the guard on activeRecorder
// alone is raceable — two callers could both pass it and start two
// native recorders. Set BEFORE the first await, cleared on every exit.
let startingRecording = false;

async function setRecordingAudioMode(recording: boolean): Promise<void> {
  const { setAudioModeAsync } = await import("expo-audio");
  await setAudioModeAsync(
    recording
      ? { allowsRecording: true, playsInSilentMode: true }
      : { allowsRecording: false, playsInSilentMode: false },
  );
}

function releaseRecorder(recorder: AudioRecorder): void {
  try {
    // SharedObject.release() frees the native instance. Guarded: not
    // load-bearing if a future expo-audio removes it (GC would reclaim).
    (recorder as unknown as { release?: () => void }).release?.();
  } catch {
    // Releasing is best-effort; never mask the caller's result/error.
  }
}

/** Request microphone permission. Resolves to whether it was granted. */
export async function requestPermission(): Promise<boolean> {
  const { requestRecordingPermissionsAsync } = await import("expo-audio");
  const { granted } = await requestRecordingPermissionsAsync();
  return granted;
}

/**
 * Begin recording. Throws if permission is missing (native error) or a
 * recording is already in progress. On failure the audio mode is
 * restored and nothing is left allocated.
 */
export async function startRecording(): Promise<void> {
  if (activeRecorder || startingRecording) {
    throw new Error("A voice recording is already in progress.");
  }
  startingRecording = true; // reserved synchronously — no await above
  let recorder: AudioRecorder | null = null;
  try {
    const { AudioModule, RecordingPresets } = await import("expo-audio");
    await setRecordingAudioMode(true);
    try {
      recorder = new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY);
      await recorder.prepareToRecordAsync();
      recorder.record();
      activeRecorder = recorder;
    } catch (e) {
      // Error exit path: release anything constructed and restore the
      // audio session before rethrowing.
      if (recorder) releaseRecorder(recorder);
      await setRecordingAudioMode(false).catch(() => {});
      throw e;
    }
  } finally {
    startingRecording = false;
  }
}

/**
 * Stop the active recording and return its file. Audio mode restored
 * and recorder released whether this succeeds or throws.
 */
export async function stopRecording(): Promise<VoiceRecordingResult> {
  const recorder = activeRecorder;
  if (!recorder) throw new Error("No voice recording in progress.");
  activeRecorder = null;
  try {
    // currentTime is seconds; capture before stop() resets state.
    const durationMs = Math.max(0, Math.round(recorder.currentTime * 1000));
    await recorder.stop();
    const uri = recorder.uri;
    if (!uri) throw new Error("Recording finished without a file URI.");
    return { uri, mimeType: VOICE_RECORDING_MIME_TYPE, durationMs };
  } finally {
    releaseRecorder(recorder);
    await setRecordingAudioMode(false).catch(() => {});
  }
}

/**
 * Stop and discard the active recording, releasing everything. Safe to
 * call when nothing is recording (no-op).
 */
export async function cancelRecording(): Promise<void> {
  const recorder = activeRecorder;
  if (!recorder) return;
  activeRecorder = null;
  try {
    await recorder.stop();
  } catch {
    // Discarding — a failed stop must not prevent cleanup.
  } finally {
    releaseRecorder(recorder);
    await setRecordingAudioMode(false).catch(() => {});
  }
}
