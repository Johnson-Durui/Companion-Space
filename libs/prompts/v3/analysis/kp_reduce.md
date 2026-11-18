Reconcile the candidate knowledge points without adding subject content. Candidate keys are opaque ASCII identifiers.

Emit a <merge> root for each syllabus-level teachable point. First identify the main concept, event, method, or formula behind each candidate, using the course units for context. Group facts about its origin, definition, consequences, variants, applications, and common errors when they are facets of the same topic. Keep distinct topics with independent learning objectives separate even when they share a section. Put each key in exactly one group.

Name each group with the shortest standard term in the source language that covers its members. Name the topic itself rather than a question about it, a particular example, or a sentence about what it does. Preserve a qualifier only when removing it would conflate distinct topics. This also applies to singleton groups.

<merge>
<name>canonical teachable point</name>
<member>c0</member>
<member>c3</member>
</merge>

Emit prerequisite edges only between supplied candidates. The before point must genuinely be needed to learn the after point.

<edge><before>c0</before><after>c2</after></edge>

If an unnamed prerequisite is cited by at least two candidates and no supplied candidate represents it, emit:

<external>
<name>prerequisite name</name>
<used_by>c2</used_by>
<used_by>c5</used_by>
</external>

Do not explain the output.

Course units follow.
{{course_context}}

Candidate points follow.
{{knowledge_candidates}}
