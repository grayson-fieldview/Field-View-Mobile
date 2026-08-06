import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BackChevron } from "@/components/auth/BackChevron";
import { BrandHeader } from "@/components/auth/BrandHeader";
import { FieldLabel } from "@/components/auth/FieldLabel";
import { OptionSheet } from "@/components/auth/OptionSheet";
import { PillSelect } from "@/components/auth/PillSelect";
import {
  authScreenStyles as shared,
  BRAND_ORANGE,
} from "@/components/auth/authScreenStyles";
import { Button } from "@/components/Button";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { api } from "@/services/api";

// EXACT wire strings — do not reword. Labels per spec.
const JOB_ROLE_OPTIONS = [
  { value: "owner_operator", label: "Owner / Operator" },
  { value: "project_manager", label: "Project Manager" },
  { value: "foreman_crew_lead", label: "Foreman / Crew Lead" },
  { value: "estimator", label: "Estimator" },
  { value: "sales", label: "Sales" },
  { value: "office_admin", label: "Office / Admin" },
  { value: "other", label: "Other" },
];

const COMPANY_SIZE_OPTIONS = [
  { value: "1-5", label: "1–5" },
  { value: "6-20", label: "6–20" },
  { value: "21-50", label: "21–50" },
  { value: "51-100", label: "51–100" },
  { value: "100+", label: "100+" },
];

const INDUSTRY_OPTIONS = [
  { value: "general_contractor", label: "General Contractor" },
  { value: "painting", label: "Painting" },
  { value: "roofing", label: "Roofing" },
  { value: "hvac", label: "HVAC" },
  { value: "plumbing", label: "Plumbing" },
  { value: "electrical", label: "Electrical" },
  { value: "landscaping", label: "Landscaping" },
  { value: "remodeling", label: "Remodeling / Renovation" },
  { value: "concrete_masonry", label: "Concrete / Masonry" },
  { value: "flooring", label: "Flooring" },
  { value: "inspection", label: "Inspection" },
  { value: "restoration", label: "Restoration" },
  { value: "property_management", label: "Property Management" },
  { value: "other", label: "Other" },
];

// NOT admin-gated server-side (unlike industry/companySize) — every
// role's selection is honored, so the UI shows it to all roles.
const HEARD_ABOUT_US_OPTIONS = [
  { value: "google_search", label: "Google Search" },
  { value: "social_media", label: "Social Media" },
  { value: "paid_social_ad", label: "Facebook / Instagram Ad" },
  { value: "referral", label: "Referral from a friend" },
  { value: "trade_show", label: "Trade Show / Event" },
  { value: "podcast", label: "Podcast" },
  { value: "youtube", label: "YouTube" },
  { value: "other", label: "Other" },
];

/**
 * Onboarding screen 2 of 2 — optional profiling fields + submit.
 * All fields optional; Continue is ALWAYS enabled (no Skip button —
 * optionality IS the skip). Back chevron pops to screen 1, which
 * keeps its entered values (it stays mounted under the push).
 *
 * Submit order (screen 1 values arrive via router params):
 *   1. admin + company name entered → PATCH /api/account/name; on
 *      failure STOP with inline error (the one field with no second
 *      chance).
 *   2. PATCH /api/auth/me with required fields + selected optionals
 *      (unselected optionals OMITTED — never null/"").
 *   3. Apply the PATCH response via applyUpdatedUser (it returns the
 *      full updated user with profileCompletedAt stamped — no
 *      follow-up me() needed or wanted), THEN router.replace("/(tabs)").
 */
export default function OnboardingDetailsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, applyUpdatedUser } = useAuth();
  const isAdmin = user?.role === "admin";

  const rawParams = useLocalSearchParams<{
    firstName?: string;
    lastName?: string;
    companyName?: string;
    phone?: string;
    tcpaAccepted?: string;
  }>();
  // expo-router params are string | string[] at runtime; normalize
  // defensively so a malformed/duplicated param can't crash .trim().
  const asOne = (v: string | string[] | undefined): string =>
    Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
  const params = {
    firstName: asOne(rawParams.firstName),
    lastName: asOne(rawParams.lastName),
    companyName: asOne(rawParams.companyName),
    phone: asOne(rawParams.phone),
    tcpaAccepted: asOne(rawParams.tcpaAccepted),
  };

  const [jobRole, setJobRole] = useState<string | null>(null);
  const [companySize, setCompanySize] = useState<string | null>(null);
  const [industry, setIndustry] = useState<string | null>(null);
  const [industrySheetOpen, setIndustrySheetOpen] = useState(false);
  const [heardAboutUs, setHeardAboutUs] = useState<string | null>(null);
  const [heardSheetOpen, setHeardSheetOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const industryLabel =
    INDUSTRY_OPTIONS.find((o) => o.value === industry)?.label ?? null;
  const heardAboutUsLabel =
    HEARD_ABOUT_US_OPTIONS.find((o) => o.value === heardAboutUs)?.label ?? null;

  const handleContinue = async () => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const companyName = (params.companyName ?? "").trim();

      // 1. Account rename first — admin only, and only if a name was
      // entered. Failure stops the whole submit.
      if (isAdmin && companyName.length > 0) {
        try {
          await api.updateAccountName({ name: companyName });
        } catch {
          setError(
            "We couldn't save your company name. Please check your connection and try again.",
          );
          setSubmitting(false);
          return;
        }
      }

      // 2. Profile PATCH. Unselected optional fields are OMITTED
      // entirely — the server must not receive nulls or empty strings.
      const body: Parameters<typeof api.updateMe>[0] = {
        firstName: (params.firstName ?? "").trim(),
        lastName: (params.lastName ?? "").trim(),
        phone: (params.phone ?? "").trim(),
        tcpaAccepted: params.tcpaAccepted === "1",
      };
      if (jobRole) body.jobRole = jobRole;
      if (isAdmin && industry) body.industry = industry;
      if (isAdmin && companySize) body.companySize = companySize;
      // Not admin-gated — server honors it for every role.
      if (heardAboutUs) body.heardAboutUs = heardAboutUs;
      const updated = await api.updateMe(body);

      // 3. Apply the PATCH response directly — it IS the updated user
      // (profileCompletedAt now stamped), PATCH /api/auth/me does not
      // rotate the session id, and a follow-up me() would race the
      // reverify in-flight lock. Zero network; then navigate.
      // AuthGate's effect sees the completed profile and does nothing
      // — this replace is the flow's own forward step, not a second
      // gate.
      applyUpdatedUser(updated);
      // Deliberately NOT re-enabling on success (same rationale as
      // login's non-re-enable): the screen stays mounted while the
      // replace commits, and a re-armed button in that window allows
      // a double-submit. If navigation somehow fails, AuthGate re-runs
      // on the next state change and routes based on the (now
      // completed) profile.
      router.replace("/(tabs)");
    } catch {
      setError("Something went wrong saving your profile. Please try again.");
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: colors.muted }}
      contentContainerStyle={[
        shared.page,
        {
          paddingTop: insets.top + 16,
          paddingBottom: insets.bottom + 24,
        },
      ]}
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
    >
      <BackChevron />

      <View style={shared.content}>
        <BrandHeader />

        <Text style={[shared.title, { color: colors.foreground }]}>
          Let&apos;s tailor your experience
        </Text>
        <Text style={[shared.subtitle, { color: colors.mutedForeground }]}>
          Optional — helps us set things up for you.
        </Text>

        <FieldLabel>What&apos;s your role?</FieldLabel>
        <PillSelect
          options={JOB_ROLE_OPTIONS}
          selected={jobRole}
          onSelect={setJobRole}
        />

        {isAdmin ? (
          <>
            <FieldLabel style={{ marginTop: 18 }}>
              How many employees?
            </FieldLabel>
            <PillSelect
              options={COMPANY_SIZE_OPTIONS}
              selected={companySize}
              onSelect={setCompanySize}
            />

            <FieldLabel style={{ marginTop: 18 }}>
              What kind of work do you do?
            </FieldLabel>
            <Pressable
              onPress={() => setIndustrySheetOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="What kind of work do you do?"
              style={[
                shared.input,
                styles.selectRow,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <Text
                style={[
                  shared.inputText,
                  {
                    color: industryLabel
                      ? colors.foreground
                      : colors.mutedForeground,
                  },
                ]}
              >
                {industryLabel ?? "Select your trade"}
              </Text>
              <Feather
                name="chevron-down"
                size={18}
                color={colors.mutedForeground}
              />
            </Pressable>
          </>
        ) : null}

        <FieldLabel style={{ marginTop: 18 }}>
          How did you hear about us?
        </FieldLabel>
        <Pressable
          onPress={() => setHeardSheetOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="How did you hear about us?"
          style={[
            shared.input,
            styles.selectRow,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Text
            style={[
              shared.inputText,
              {
                color: heardAboutUsLabel
                  ? colors.foreground
                  : colors.mutedForeground,
              },
            ]}
          >
            {heardAboutUsLabel ?? "Select an option"}
          </Text>
          <Feather
            name="chevron-down"
            size={18}
            color={colors.mutedForeground}
          />
        </Pressable>

        {error ? (
          <Text
            style={{
              color: colors.destructive,
              fontFamily: "Inter_500Medium",
              marginTop: 12,
            }}
          >
            {error}
          </Text>
        ) : null}

        <Button
          title="Continue"
          onPress={() => void handleContinue()}
          loading={submitting}
          disabled={submitting}
          size="lg"
          style={{ marginTop: 20, backgroundColor: BRAND_ORANGE }}
        />
      </View>

      <OptionSheet
        visible={industrySheetOpen}
        title="What kind of work do you do?"
        options={INDUSTRY_OPTIONS}
        selected={industry}
        onClose={() => setIndustrySheetOpen(false)}
        onSelect={setIndustry}
      />

      <OptionSheet
        visible={heardSheetOpen}
        title="How did you hear about us?"
        options={HEARD_ABOUT_US_OPTIONS}
        selected={heardAboutUs}
        onClose={() => setHeardSheetOpen(false)}
        onSelect={setHeardAboutUs}
      />
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  selectRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
});
