/**
 * Shared detection for expo-audio being unavailable at runtime.
 *
 * services/voiceRecording.ts loads expo-audio DYNAMICALLY, so a dev or
 * production client whose native build predates the module (or whose
 * native module fails to initialize) surfaces the failure as a thrown
 * error from the first `await import("expo-audio")` — not at bundle
 * eval. Every UI entry point that can trigger that import must catch
 * and route through this heuristic so the failure degrades to inline
 * messaging instead of an unhandled rejection (a crash in production).
 *
 * Heuristic match on the error message; used by VoiceNoteButton and
 * the walkthrough start path in app/capture.tsx.
 */
export function isModuleUnavailableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /cannot find module|requiring unknown module|native module|expo-audio|turbomodule|nativemodule/i.test(
    msg,
  );
}
