Create one source-grounded lesson plan as a single JSON object inside a lesson_plan tag.

{{course_context}}
{{page_content}}
{{existing_items}}
{{? lesson_feedback}}

Return this shape:

    {
      "title": "...", "est_minutes": 25,
      "objectives": [{"kp_id": "...", "text": "..."}],
      "segments": [{
        "id": "s1", "kp_id": "...", "kind": "concept", "goal": "...", "est_minutes": 10,
        "keypoints": ["...", "..."],
        "approaches": [
          {"kind": "intuition", "keypoint": "all", "outline": "..."},
          {"kind": "visual", "keypoint": "all", "outline": "..."},
          {"kind": "example", "keypoint": "all", "outline": "..."},
          {"kind": "formal", "keypoint": "all", "outline": "..."}
        ],
        "examples": [{"type": "numeric", "stem": "...", "answer": "...", "solution": "..."}],
        "misconceptions": ["..."], "checks": ["c1", "c2", "c3"], "backfills": []
      }],
      "practice": [], "wrap": {"summary_points": ["..."], "cards": []},
      "items": {"c1": {"bank_id": "...", "keypoints": [0], "fallback_hints": {"1": "...", "2": "..."}}}
    }

For a verified-bank reference, provide bank_id, keypoints and fallback_hints. Spoken stem and
distractor metadata are optional. Never copy or alter its answer or solution. For a newly generated
question, also provide its full stem, type, answer, solution, kp_id and any options or rubric required
for its type. Every question in items, including a bank reference, needs fallback_hints with two
non-empty strings at keys "1" and "2". The second hint gives more direction without revealing the answer.
The exact supported type names are choice, multi, numeric, short, steps, and explain. Do not invent other type names.
The application independently solves every new question and worked example before accepting it.
Write every stem so it can be solved without seeing its answer, solution, options, or other questions;
prefer numeric questions when the source makes that appropriate.
Use verified bank items wherever they match the current keypoint. For newly generated quantitative checks
and variants, use precise numeric answers (integers, terminating decimals, or reduced fractions) with a
complete worked solution. For each choice question, check the answer value against every option and rule out
duplicate equivalent options. When a validation diagnostic identifies a failed item, replace that item with
a simpler question whose solution uses only the cited source, and keep the required distinct checks and variants.

Each segment has two or three keypoints. Start with four different approach entries with keypoint
exactly "all", as shown above, and give each a substantive outline that covers the segment. Optional
entries for a specific keypoint use its zero-based integer index. Allowed kinds are intuition, visual,
example, formal, analogy, and contrast.

Provide at least two solved worked examples. Supply at least one distinct check per keypoint. For the
check assigned to keypoint index N, keypoints must include N and may contain only indices 0 through N.
The question must actually require keypoint N and must be answerable without later keypoints. Provide at least one extra check and include
at least two variants. For a variant, set variant_of to the lesson-local ID of its base question.
For an independent new base question, use variant_of: null. Both keep the same verification requirements.
Include an objective check among them. Use only supplied source pages and knowledge point identifiers.
Include an objective check for every segment even when it also needs a rubric item. Use an eligible
verified single-choice item from the supplied bank as a check if its reasoning matches a taught keypoint.
When a validation diagnostic is supplied, correct that issue while satisfying all the other requirements.
Do not include commentary or Markdown fences outside the required tag.
