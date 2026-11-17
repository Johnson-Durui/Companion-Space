Create one source-grounded lesson plan as a single JSON object inside a lesson_plan tag.

{{course_context}}
{{page_content}}
{{existing_items}}

Return this shape:

    {
      "title": "...", "est_minutes": 25,
      "objectives": [{"kp_id": "...", "text": "..."}],
      "segments": [{
        "id": "s1", "kp_id": "...", "kind": "concept", "goal": "...", "est_minutes": 10,
        "keypoints": ["...", "..."],
        "approaches": [{"kind": "intuition", "keypoint": "all", "outline": "..."}],
        "examples": [{"type": "numeric", "stem": "...", "answer": "...", "solution": "..."}],
        "misconceptions": ["..."], "checks": ["c1", "c2", "c3"], "backfills": []
      }],
      "practice": [], "wrap": {"summary_points": ["..."], "cards": []},
      "items": {"c1": {"bank_id": "...", "keypoints": [0], "fallback_hints": {"1": "...", "2": "..."}}}
    }

Reference an existing verified question with an object containing only its bank_id plus optional
keypoints, spoken stem, hints, and distractor metadata. Never copy or alter its answer or solution.
A new question must include its full stem, type, answer, solution, kp_id, keypoints, two non-leaking
fallback hints, and any options or rubric required for its type. The application independently solves
every new question and worked example before accepting it.

Each segment has two or three keypoints. Give every keypoint at least four distinct approaches selected
from intuition, example, visual, formal, analogy, and contrast. Provide at least two solved worked examples.
Checks number at least keypoints plus one, include an objective question, cover every keypoint, and include
at least two items whose variant_of names their base item. Use only supplied source pages and knowledge
point identifiers. Do not include commentary or Markdown fences outside the required tag.
