Create {{generation_count}} objective diagnostic question for each supplied knowledge point that lacks a suitable existing item. Use only facts in the supplied point. Prefer difficulty 2. Do not repeat an existing question.

For each question emit:

<item>
<kp>exact knowledge point id</kp>
<type>choice|multi|numeric</type>
<stem>question stem</stem>
<option><key>A</key><text>option text</text></option>
<answer>answer</answer>
<solution>concise complete solution</solution>
<difficulty>1|2|3</difficulty>
</item>

Course metadata follows.
{{course_context}}

Knowledge points follow.
{{knowledge_candidates}}

Existing items follow.
{{existing_items}}
