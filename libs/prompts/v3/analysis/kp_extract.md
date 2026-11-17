Extract the smallest teachable knowledge points supported by the source pages. A point must be testable by one question. Ignore anecdotes unless they are examinable. Return 3–10 points for an ordinary section and never invent information.

For every point, emit one root block in this exact shape. All enum values are ASCII.

<kp>
<name>name in the source language</name>
<kind>concept|theorem|formula|method|skill|fact</kind>
<importance>core|important|peripheral</importance>
<difficulty>1|2|3</difficulty>
<summary>source-grounded concise summary</summary>
<must_know>one required fact</must_know>
<must_know>another required fact when needed</must_know>
<formula>optional formula, empty when absent</formula>
<prerequisite>prerequisite name when supported</prerequisite>
<pitfall>one common error supported or implied by the source</pitfall>
<question_type>one examinable question form</question_type>
<pages>comma-separated source page numbers</pages>
</kp>

Course metadata follows.
{{course_context}}

Source pages follow.
{{page_content}}
