Generate {{generation_count}} additional source-grounded questions for this knowledge point.

{{course_context}}
{{page_content}}
{{existing_items}}

Return one JSON array inside an items tag. Each entry must include a unique id, kp_id, type, difficulty,
stem, spoken stem, answer, solution, keypoints, and two non-leaking fallback_hints keyed 1 and 2.
Choice options use an array of objects with key and text. A variant_of value may reference only a supplied
bank_id. Do not repeat an existing item. Do not use a reserved exam or invent a source. Every result is
independently solved and discarded unless verification succeeds. Output no prose outside the required tag.
