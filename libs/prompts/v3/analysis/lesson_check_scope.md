Judge whether the question genuinely tests the requested target lesson point without needing any later
lesson point. The question intentionally omits its answer and solution. Judge only semantic dependencies,
not whether an answer is correct.

{{check_slot}}
{{item_context}}

Return exactly one JSON object inside a check_scope tag with this shape:

    {"requires_target": true, "uses_later": false}

requires_target is true only when solving the question actually requires the target text, rather than an
earlier point or general knowledge alone. uses_later is true when solving requires any concept listed under
later. Use false when uncertain about requires_target and true when uncertain about uses_later. Output no
prose outside the required tag.
