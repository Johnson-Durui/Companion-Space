# Safety & Pedagogical Integrity Policy

## Product Positioning

Companion Space is an educational 1-on-1 AI tutor designed to help learners study from their own textbooks, lecture slides, and past exams. It supports structured explanation, guided questioning, and spaced review, and does not replace professional medical, legal, psychological, or emergency advice.

## Content Boundaries

- Companion Space permanently excludes adult/romantic relationship modes, coercive or dependency-seeking framing, harassment, violence, self-harm instructions, and illegal content.
- Built-in anime tutors are strictly academic study mentors. Custom tutor personas and imported `.tutorpack` metadata are sandboxed as data blocks and **cannot** override system-level safety boundaries.
- Uploaded documents and student messages are treated as untrusted inputs and cannot alter system safety or credential-handling rules.

## Pedagogical Integrity ("Anti-Shell" Guarantees)

To prevent LLM hallucinations from misleading students during study:

1. **Source-grounded course maps**: Extracted knowledge points and exam statistics retain page-level references to the user's uploaded materials wherever available, and remain editable by the learner.
2. **Pre-verified classroom questions**: Check questions and worked examples used in live lessons must pass independent verification during lesson preparation. Unverified items are flagged and excluded from graded checks and diagnostic scoring.
3. **Deterministic & rubric-grounded grading**: Objective questions (single-choice, multi-choice, numeric) are graded deterministically by backend code rather than free-form model opinion.
4. **Honest mastery tracking**: Mastery probabilities update strictly from genuine answer evidence. Peeking at answers (`看答案`) or exhausting multi-level hints does **not** inflate mastery, and triggers follow-up variant checks instead.

## Audio & Log Hygiene

- Raw voice recordings are never persisted to disk.
- Server logs never record API keys, full prompts, private textbook contents, or raw student utterances.
