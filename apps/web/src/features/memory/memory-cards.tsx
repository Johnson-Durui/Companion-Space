import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Loading, Problem } from "../../app/ui";
import {
  Badge,
  Brain,
  Button,
  Card,
  ExternalLink,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  TextInput,
  Trash2,
  toast,
} from "../../ui";
import t from "../../locales/zh-CN.json";
import {
  getMemoryArchive,
  listCourseMemories,
  memoryKeys,
  patchCourseMemory,
  patchGlobalMemoryNote,
  refreshCourseMemories,
  refreshMemoryArchive,
  type CourseMemoryFact,
  type GlobalSynthesisNote,
} from "./api";

const copy = t.memory;

function kindLabel(kind: string): string {
  return copy.kinds[kind as keyof typeof copy.kinds] ?? kind;
}

function refKindLabel(kind: string): string {
  return copy.refKinds[kind as keyof typeof copy.refKinds] ?? kind;
}

function CourseMemoryRow({
  fact,
  showCourse,
  onSaveStatement,
  onTogglePin,
  onForget,
  pending,
}: {
  fact: CourseMemoryFact;
  showCourse?: boolean;
  onSaveStatement: (statement: string) => void;
  onTogglePin: () => void;
  onForget: () => void;
  pending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.statement);
  const pinned = fact.status === "pinned";

  function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleaned = draft.trim();
    if (!cleaned) return;
    onSaveStatement(cleaned);
    setEditing(false);
  }

  return (
    <li
      data-testid={`memory-fact-${fact.id}`}
      data-status={fact.status}
      className="grid gap-2.5 rounded-md border border-line-subtle bg-surface-page p-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={pinned ? "accent" : "neutral"}>{kindLabel(fact.kind)}</Badge>
          {showCourse && fact.course_name ? (
            <Link
              to={`/courses/${fact.course_id}/progress`}
              className="rounded-pill bg-surface-sunken px-2 py-0.5 text-caption font-medium text-fg-secondary hover:text-fg-primary"
            >
              {fact.course_name}
            </Link>
          ) : null}
          {fact.kp_name ? <Badge tone="neutral">{fact.kp_name}</Badge> : null}
          {pinned ? <Badge tone="accent">{copy.pinnedBadge}</Badge> : null}
          {fact.user_edited ? <Badge tone="ok">{copy.editedBadge}</Badge> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            leftIcon={pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
            onClick={onTogglePin}
          >
            {pinned ? copy.unpin : copy.pin}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            leftIcon={<Pencil size={14} aria-hidden="true" />}
            onClick={() => {
              setDraft(fact.statement);
              setEditing((prev) => !prev);
            }}
          >
            {copy.edit}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            leftIcon={<Trash2 size={14} aria-hidden="true" />}
            onClick={onForget}
          >
            {copy.forget}
          </Button>
        </div>
      </div>

      {editing ? (
        <form className="flex flex-wrap items-center gap-2" onSubmit={submitEdit}>
          <TextInput
            value={draft}
            maxLength={160}
            aria-label={copy.edit}
            className="min-w-[200px] flex-1"
            onChange={(event) => setDraft(event.target.value)}
            autoFocus
          />
          <Button type="submit" variant="primary" size="sm" pending={pending} disabled={!draft.trim()}>
            {copy.saveEdit}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(false)}>
            {t.common.cancel}
          </Button>
        </form>
      ) : (
        <p className="m-0 text-ui leading-relaxed text-fg-primary">{fact.statement}</p>
      )}

      {fact.evidence_refs.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 text-caption text-fg-tertiary">
          <span>{copy.evidenceLabel}</span>
          {fact.evidence_refs.map((ref) =>
            ref.href ? (
              <Link
                key={`${ref.kind}:${ref.id}`}
                to={ref.href}
                className="inline-flex items-center gap-1 rounded-pill border border-line-subtle bg-surface-card px-2 py-0.5 text-caption text-accent-strong hover:underline"
              >
                <span>{refKindLabel(ref.kind)}</span>
                <ExternalLink size={11} aria-hidden="true" />
              </Link>
            ) : (
              <span
                key={`${ref.kind}:${ref.id}`}
                className="rounded-pill border border-line-subtle bg-surface-card px-2 py-0.5"
              >
                {refKindLabel(ref.kind)}
              </span>
            ),
          )}
        </div>
      ) : null}
    </li>
  );
}

export function CourseMemoryCard({ courseId }: { courseId: string }) {
  const queries = useQueryClient();
  const query = useQuery({
    queryKey: memoryKeys.course(courseId),
    queryFn: () => listCourseMemories(courseId),
    enabled: Boolean(courseId),
  });

  const refresh = useMutation({
    mutationFn: () => refreshCourseMemories(courseId),
    onSuccess: (items) => {
      queries.setQueryData(memoryKeys.course(courseId), items);
      void queries.invalidateQueries({ queryKey: memoryKeys.archive, exact: true });
      toast.success(copy.updatedToast);
    },
  });

  const patch = useMutation({
    mutationFn: ({
      memoryId,
      body,
    }: {
      memoryId: string;
      body: { statement?: string; status?: "active" | "pinned" | "dismissed" };
    }) => patchCourseMemory(courseId, memoryId, body),
    onSuccess: (updated, vars) => {
      queries.setQueryData<CourseMemoryFact[]>(memoryKeys.course(courseId), (prev) => {
        if (!prev) return prev;
        if (updated.status === "dismissed") {
          return prev.filter((item) => item.id !== updated.id);
        }
        const next = prev.map((item) => (item.id === updated.id ? updated : item));
        return next.sort((a, b) => (a.status === "pinned" ? 0 : 1) - (b.status === "pinned" ? 0 : 1));
      });
      void queries.invalidateQueries({ queryKey: memoryKeys.archive, exact: true });
      toast.success(vars.body.status === "dismissed" ? copy.forgottenToast : t.common.saved);
    },
  });

  return (
    <Card padding="lg" className="cs-bento-card grid gap-4" data-testid="course-memory-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-accent-soft text-accent-strong">
              <Brain size={15} aria-hidden="true" />
            </span>
            <h2 className="text-title font-semibold text-fg-primary">{copy.courseHeading}</h2>
          </div>
          <p className="text-ui text-fg-secondary">{copy.courseLead}</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          pending={refresh.isPending}
          leftIcon={<RefreshCw size={14} aria-hidden="true" />}
          onClick={() => refresh.mutate()}
        >
          {copy.refreshCourse}
        </Button>
      </div>

      {refresh.isError ? <Problem error={refresh.error} /> : null}
      {patch.isError ? <Problem error={patch.error} /> : null}

      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Problem error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.length === 0 ? (
        <p className="rounded-md bg-surface-page px-4 py-3 text-ui text-fg-secondary">{copy.emptyCourse}</p>
      ) : (
        <ul className="grid gap-3">
          {query.data.map((fact) => (
            <CourseMemoryRow
              key={fact.id}
              fact={fact}
              pending={patch.isPending}
              onSaveStatement={(statement) => patch.mutate({ memoryId: fact.id, body: { statement } })}
              onTogglePin={() =>
                patch.mutate({
                  memoryId: fact.id,
                  body: { status: fact.status === "pinned" ? "active" : "pinned" },
                })
              }
              onForget={() => patch.mutate({ memoryId: fact.id, body: { status: "dismissed" } })}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function GlobalNoteRow({
  note,
  pending,
  onSaveStatement,
  onTogglePin,
  onForget,
}: {
  note: GlobalSynthesisNote;
  pending: boolean;
  onSaveStatement: (statement: string) => void;
  onTogglePin: () => void;
  onForget: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.statement);
  const pinned = note.status === "pinned";

  return (
    <li
      data-testid={`global-memory-note-${note.id}`}
      className="grid gap-2 rounded-md border border-line-subtle bg-surface-page p-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {pinned ? <Badge tone="accent">{copy.pinnedBadge}</Badge> : null}
          {note.user_edited ? <Badge tone="ok">{copy.editedBadge}</Badge> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            leftIcon={pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
            onClick={onTogglePin}
          >
            {pinned ? copy.unpin : copy.pin}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            leftIcon={<Pencil size={14} aria-hidden="true" />}
            onClick={() => {
              setDraft(note.statement);
              setEditing((prev) => !prev);
            }}
          >
            {copy.edit}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            leftIcon={<Trash2 size={14} aria-hidden="true" />}
            onClick={onForget}
          >
            {copy.forget}
          </Button>
        </div>
      </div>

      {editing ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.trim()) return;
            onSaveStatement(draft.trim());
            setEditing(false);
          }}
        >
          <TextInput
            value={draft}
            maxLength={160}
            aria-label={copy.edit}
            className="min-w-[200px] flex-1"
            onChange={(event) => setDraft(event.target.value)}
            autoFocus
          />
          <Button type="submit" variant="primary" size="sm" pending={pending} disabled={!draft.trim()}>
            {copy.saveEdit}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(false)}>
            {t.common.cancel}
          </Button>
        </form>
      ) : (
        <p className="m-0 text-ui leading-relaxed text-fg-primary">{note.statement}</p>
      )}
    </li>
  );
}

export function GlobalMemoryArchiveCard() {
  const queries = useQueryClient();
  const archive = useQuery({
    queryKey: memoryKeys.archive,
    queryFn: getMemoryArchive,
  });

  const refresh = useMutation({
    mutationFn: refreshMemoryArchive,
    onSuccess: (next) => {
      queries.setQueryData(memoryKeys.archive, next);
      toast.success(copy.updatedToast);
    },
  });

  const patchGlobal = useMutation({
    mutationFn: ({
      noteId,
      body,
    }: {
      noteId: string;
      body: { statement?: string; status?: "active" | "pinned" | "dismissed" };
    }) => patchGlobalMemoryNote(noteId, body),
    onSuccess: (next, vars) => {
      queries.setQueryData(memoryKeys.archive, next);
      toast.success(vars.body.status === "dismissed" ? copy.forgottenToast : t.common.saved);
    },
  });

  const patchCourse = useMutation({
    mutationFn: ({
      courseId,
      memoryId,
      body,
    }: {
      courseId: string;
      memoryId: string;
      body: { statement?: string; status?: "active" | "pinned" | "dismissed" };
    }) => patchCourseMemory(courseId, memoryId, body),
    onSuccess: (_, vars) => {
      void queries.invalidateQueries({ queryKey: memoryKeys.archive, exact: true });
      void queries.invalidateQueries({ queryKey: memoryKeys.course(vars.courseId), exact: true });
      toast.success(vars.body.status === "dismissed" ? copy.forgottenToast : t.common.saved);
    },
  });

  return (
    <Card padding="lg" className="grid gap-5" data-testid="global-memory-archive-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line-subtle pb-4">
        <div className="grid gap-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-accent-soft text-accent-strong">
              <Brain size={15} aria-hidden="true" />
            </span>
            <h2 className="text-title font-semibold text-fg-primary">{copy.archiveHeading}</h2>
          </div>
          <p className="text-ui text-fg-secondary">{copy.archiveLead}</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          pending={refresh.isPending}
          disabled={(archive.data?.total_active_facts ?? 0) === 0}
          leftIcon={<RefreshCw size={14} aria-hidden="true" />}
          onClick={() => refresh.mutate()}
        >
          {copy.refreshArchive}
        </Button>
      </div>

      {refresh.isError ? <Problem error={refresh.error} /> : null}
      {patchGlobal.isError ? <Problem error={patchGlobal.error} /> : null}
      {patchCourse.isError ? <Problem error={patchCourse.error} /> : null}

      {archive.isPending ? (
        <Loading />
      ) : archive.isError ? (
        <Problem error={archive.error} onRetry={() => void archive.refetch()} />
      ) : (
        <div className="grid gap-5">
          {archive.data.synthesis_notes.length === 0 ? (
            <p className="rounded-md bg-surface-page px-4 py-3 text-ui text-fg-secondary">
              {copy.emptyArchive}
            </p>
          ) : (
            <ul className="grid gap-3">
              {archive.data.synthesis_notes.map((note) => (
                <GlobalNoteRow
                  key={note.id}
                  note={note}
                  pending={patchGlobal.isPending}
                  onSaveStatement={(statement) =>
                    patchGlobal.mutate({ noteId: note.id, body: { statement } })
                  }
                  onTogglePin={() =>
                    patchGlobal.mutate({
                      noteId: note.id,
                      body: { status: note.status === "pinned" ? "active" : "pinned" },
                    })
                  }
                  onForget={() =>
                    patchGlobal.mutate({ noteId: note.id, body: { status: "dismissed" } })
                  }
                />
              ))}
            </ul>
          )}

          {archive.data.course_memories.length > 0 ? (
            <div className="grid gap-3 border-t border-line-subtle pt-4">
              <h3 className="text-ui font-semibold text-fg-primary">{copy.courseFactsSubheading}</h3>
              <ul className="grid gap-2.5">
                {archive.data.course_memories.map((fact) => (
                  <CourseMemoryRow
                    key={fact.id}
                    fact={fact}
                    showCourse
                    pending={patchCourse.isPending}
                    onSaveStatement={(statement) =>
                      patchCourse.mutate({
                        courseId: fact.course_id,
                        memoryId: fact.id,
                        body: { statement },
                      })
                    }
                    onTogglePin={() =>
                      patchCourse.mutate({
                        courseId: fact.course_id,
                        memoryId: fact.id,
                        body: { status: fact.status === "pinned" ? "active" : "pinned" },
                      })
                    }
                    onForget={() =>
                      patchCourse.mutate({
                        courseId: fact.course_id,
                        memoryId: fact.id,
                        body: { status: "dismissed" },
                      })
                    }
                  />
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}
