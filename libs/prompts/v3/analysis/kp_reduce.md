Reconcile the candidate knowledge points without adding subject content. Candidate keys are opaque ASCII identifiers.

Emit a <merge> root for each group of candidates that represents the same teachable point. Put each key in exactly one group. Keep distinct points separate when uncertain.

<merge>
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
