import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BrandHeader } from "@/components/auth/BrandHeader";
import {
  authScreenStyles as shared,
} from "@/components/auth/authScreenStyles";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { api, ApiError, normalizeUser } from "@/services/api";

const RESEND_COOLDOWN_SECONDS = 60;

/**
 * Email verification screen — collects the 6-digit code sent to the
 * signed-in user's email and POSTs /api/verify-email-code.
 *
 * NOT yet reachable: AuthGate routing for needsEmailVerification lands
 * in a separate gate (do not add navigation here). On success we apply
 * the returned user via applyUpdatedUser — the same zero-network path
 * onboarding-details uses — so the cached snapshot picks up
 * emailVerified and AuthGate (once wired) routes off the state change.
 *
 * Naming: emailVerified / needsEmailVerification only. Never
 * "verified"/"unverified" — that vocabulary belongs to AuthContext's
 * session re-verification machinery.
 */
export default function VerifyEmailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, applyUpdatedUser } = useAuth();
  const email = typeof user?.email === "string" ? user.email : "";

  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Resend cooldown. Starts full on mount — a code was just sent by
  // whatever flow landed the user here (signup / resend on web).
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startCooldown = (seconds: number) => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setCooldown(seconds);
    intervalRef.current = setInterval(() => {
      setCooldown((s) => {
        if (s <= 1) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          intervalRef.current = null;
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  };
  useEffect(() => {
    startCooldown(RESEND_COOLDOWN_SECONDS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleVerify = async () => {
    if (submitting) return;
    setError(null);
    setInfo(null);
    setSubmitting(true);
    try {
      const updated = await api.verifyEmailCode(email, code.trim());
      // Unwrap the BackendUser | { user } | null union the same way
      // the OAuth completion path does (completeOAuthSignIn →
      // normalizeUser). applyUpdatedUser would normalize internally
      // too, but it fails SILENTLY (console.warn) on a bad body —
      // here a 200 that doesn't contain a user must surface as an
      // error, not leave the user staring at a screen that did
      // nothing.
      const me = normalizeUser(updated);
      if (!me) {
        setError(
          "Verification succeeded but we couldn't load your account. Please try again.",
        );
        setSubmitting(false);
        return;
      }
      // Full user (emailVerified stamped) — same path as
      // onboarding-details: apply the response, no follow-up me(),
      // NO manual navigation (AuthGate owns routing in gate 2).
      applyUpdatedUser(me);
    } catch (e) {
      const body =
        e instanceof ApiError && e.body && typeof e.body === "object"
          ? (e.body as Record<string, unknown>)
          : {};
      const codeName = typeof body.error === "string" ? body.error : null;
      if (codeName === "invalid_code") {
        const remaining =
          typeof body.remaining_attempts === "number"
            ? body.remaining_attempts
            : null;
        setError(
          remaining != null
            ? `That code isn't right. ${remaining} attempt${remaining === 1 ? "" : "s"} left.`
            : "That code isn't right.",
        );
      } else if (codeName === "code_expired") {
        setError("That code has expired. Request a new one below.");
        setCode("");
      } else if (codeName === "too_many_attempts") {
        setError(
          "Too many attempts — that code no longer works. Request a new one below.",
        );
        setCode("");
      } else if (codeName === "no_active_code") {
        setError("No active code. Request a new one below.");
        setCode("");
      } else {
        setError(
          e instanceof Error && e.message ? e.message : "Verification failed.",
        );
      }
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
  };

  const handleResend = async () => {
    if (resending || cooldown > 0) return;
    setError(null);
    setInfo(null);
    setResending(true);
    try {
      await api.resendVerification(email);
      setInfo("A new code is on its way.");
      startCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        const body =
          e.body && typeof e.body === "object"
            ? (e.body as Record<string, unknown>)
            : {};
        const retryAfter =
          typeof body.retry_after_seconds === "number" &&
          body.retry_after_seconds > 0
            ? Math.ceil(body.retry_after_seconds)
            : RESEND_COOLDOWN_SECONDS;
        setError("Please wait before requesting another code.");
        startCooldown(retryAfter);
      } else {
        setError(
          e instanceof Error && e.message ? e.message : "Couldn't resend.",
        );
      }
    } finally {
      setResending(false);
    }
  };

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: colors.muted }}
      contentContainerStyle={[
        shared.page,
        { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 },
      ]}
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
    >
      <View style={shared.content}>
        <BrandHeader />

        <Text style={[shared.title, { color: colors.foreground }]}>
          Check your email
        </Text>
        <Text style={[shared.subtitle, { color: colors.mutedForeground }]}>
          Enter the 6-digit code we sent to{" "}
          <Text style={{ fontFamily: "Inter_600SemiBold" }}>
            {email || "your email"}
          </Text>
        </Text>

        <View style={styles.form}>
          <Input
            label="Verification code"
            value={code}
            onChangeText={(t) => setCode(t.replace(/[^0-9]/g, ""))}
            placeholder="123456"
            keyboardType="number-pad"
            maxLength={6}
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            style={styles.codeInput}
          />

          {error ? (
            <Text
              style={{
                color: colors.destructive,
                fontFamily: "Inter_500Medium",
                textAlign: "center",
              }}
            >
              {error}
            </Text>
          ) : null}
          {info ? (
            <Text
              style={{
                color: colors.mutedForeground,
                fontFamily: "Inter_500Medium",
                textAlign: "center",
              }}
            >
              {info}
            </Text>
          ) : null}

          <Button
            title="Verify"
            onPress={handleVerify}
            loading={submitting}
            disabled={code.length !== 6}
            size="lg"
          />
          <Button
            title={
              cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"
            }
            variant="ghost"
            onPress={handleResend}
            loading={resending}
            disabled={cooldown > 0}
          />
        </View>
      </View>
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  form: { gap: 14, marginTop: 8 },
  codeInput: {
    textAlign: "center",
    fontSize: 24,
    letterSpacing: 8,
    fontFamily: "Inter_600SemiBold",
  },
});
