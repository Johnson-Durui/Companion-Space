Segment every question in the supplied exam pages and attach answers from later answer pages by question number. Preserve wording and mathematics. Split independently scored subquestions and set their parent number. Do not solve missing answers.

Emit exactly one paper root:

<paper>
<name>exam name</name>
<year>four digit year, or empty</year>
<full_score>number, or empty</full_score>
</paper>

Then emit every item in order:

<item>
<no>question number</no>
<parent_no>parent question number, or empty</parent_no>
<type>choice|multi|numeric|blank|short|proof|essay</type>
<stem>complete stem</stem>
<option><key>A</key><text>option text</text></option>
<answer>reference answer, or empty</answer>
<solution>source solution, or empty</solution>
<score>number, or empty</score>
<difficulty>1|2|3</difficulty>
<pages>comma-separated source page numbers</pages>
</item>

Course and material metadata follow.
{{course_context}}

Exam pages follow.
{{page_content}}
