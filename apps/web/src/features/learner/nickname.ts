const GENERIC_PRONOUNS = new Set(["你", "您"]);

/**
 * D3 nickname precedence rule:
 * Learner profile nickname (set in Onboarding Step 2 or Settings > Me) takes priority.
 * Tutor's `address_user_as` is used ONLY when profile nickname is empty/whitespace
 * and the fallback is an actual form of address rather than a generic second-person pronoun.
 */
export function resolveLearnerNickname(
  profileNickname?: string | null,
  tutorAddressUserAs?: string | null,
): string {
  const fromProfile = (profileNickname ?? "").trim();
  if (fromProfile) return fromProfile;
  const fromTutor = (tutorAddressUserAs ?? "").trim();
  if (!fromTutor || GENERIC_PRONOUNS.has(fromTutor)) return "";
  return fromTutor;
}
