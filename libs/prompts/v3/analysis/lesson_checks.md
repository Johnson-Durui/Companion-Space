Generate exactly one source-grounded objective check for every requested lesson check slot.

{{check_slots}}
{{page_content}}
{{existing_items}}

Return one JSON array inside an items tag. Every entry must copy its slot, kp_id and target_index from
one requested slot. Its keypoints must include target_index and may contain only indices represented by
that slot's taught list. The question must actually require the target keypoint to solve, while requiring
no concept listed under later. Include type, difficulty, stem, answer, solution, variant_of: null, and two
non-leaking fallback_hints keyed "1" and "2". Use an objectively gradable type: choice, multi, numeric,
or short. Choice options use an array of objects with key and text. Do not repeat an existing item.
Write every stem so it can be solved without seeing its answer, solution, options, or other questions;
prefer numeric questions when the source makes that appropriate.
Every result is independently checked for its dependencies, solved, and discarded unless both checks
succeed. Use only the supplied sources. Output no prose outside the required tag.
