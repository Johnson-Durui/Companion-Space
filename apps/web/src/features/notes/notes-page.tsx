import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { BoardBlock, type Block } from "@companion-space/board";
import { Loading, Problem } from "../../app/ui";
import {
  Badge,
  Button,
  Card,
  Check,
  ConfirmDialog,
  Download,
  EmptyState,
  ExternalLink,
  Field,
  FileText,
  Layers,
  Pencil,
  Plus,
  Select,
  Sparkles,
  TextInput,
  Textarea,
  Trash2,
  X,
  toast,
} from "../../ui";
import t from "../../locales/zh-CN.json";
import { courseKeys } from "../courses/api";
import {
  addNoteBlock,
  createCourseNote,
  createFlashcardFromNoteBlock,
  deleteCourseNote,
  deleteNoteBlock,
  getCourseNote,
  listCourseNotes,
  noteExportUrl,
  notesKeys,
  suggestNoteAdditions,
  updateNoteBlock,
  type CourseNoteDetail,
  type NoteBlockItem,
  type NoteSuggestionItem,
} from "./api";

const copy = t.notes;

const VALID_BOARD_TYPES = new Set<Block["type"]>([
  "title",
  "text",
  "math",
  "list",
  "table",
  "code",
  "callout",
  "steps",
  "diagram",
  "plot",
  "image",
]);

function toBoardBlock(item: Pick<NoteBlockItem, "id" | "block_type" | "title" | "content">): Block {
  const safeType: Block["type"] = VALID_BOARD_TYPES.has(item.block_type as Block["type"])
    ? (item.block_type as Block["type"])
    : "text";
  return {
    id: item.id,
    type: safeType,
    title: item.title ?? undefined,
    content: item.content,
  };
}

const BLOCK_TYPE_OPTIONS = Object.entries(copy.blockTypes).map(([value, label]) => ({ value, label }));

function BlockSourceBadge({
  courseId,
  sourceRef,
}: {
  courseId: string;
  sourceRef: Record<string, unknown> | null | undefined;
}) {
  if (!sourceRef) return null;
  const kind = typeof sourceRef.kind === "string" ? sourceRef.kind : "";
  if (kind === "material_page") {
    const materialId = typeof sourceRef.material_id === "string" ? sourceRef.material_id : "";
    const pageNo = typeof sourceRef.page_no === "number" ? sourceRef.page_no : 0;
    const title = typeof sourceRef.material_title === "string" ? sourceRef.material_title : t.courses.source;
    if (materialId && pageNo > 0) {
      return (
        <Link
          to={`/courses/${courseId}/materials/${materialId}/read?page=${pageNo}`}
          className="inline-flex items-center gap-1 rounded-pill border border-line-subtle bg-surface-card px-2.5 py-0.5 text-caption text-accent-strong hover:underline"
        >
          <span>
            {copy.sourceCite.replace("{title}", title).replace("{page}", String(pageNo))}
          </span>
          <ExternalLink size={11} aria-hidden="true" />
        </Link>
      );
    }
  }
  if (kind === "lesson") {
    const lessonId = typeof sourceRef.lesson_id === "string" ? sourceRef.lesson_id : "";
    return lessonId ? (
      <Link
        to={`/lessons/${lessonId}/history`}
        className="inline-flex items-center gap-1 rounded-pill border border-line-subtle bg-surface-card px-2.5 py-0.5 text-caption text-fg-secondary hover:text-fg-primary"
      >
        <span>{copy.sourceClassroom}</span>
        <ExternalLink size={11} aria-hidden="true" />
      </Link>
    ) : (
      <Badge tone="neutral">{copy.sourceClassroom}</Badge>
    );
  }
  if (kind === "solve") {
    const solveId = typeof sourceRef.solve_session_id === "string" ? sourceRef.solve_session_id : "";
    return solveId ? (
      <Link
        to={`/courses/${courseId}/solve?session=${solveId}`}
        className="inline-flex items-center gap-1 rounded-pill border border-line-subtle bg-surface-card px-2.5 py-0.5 text-caption text-fg-secondary hover:text-fg-primary"
      >
        <span>{copy.sourceSolve}</span>
        <ExternalLink size={11} aria-hidden="true" />
      </Link>
    ) : (
      <Badge tone="neutral">{copy.sourceSolve}</Badge>
    );
  }
  return null;
}

function NoteBlockCard({
  courseId,
  block,
  busy,
  onSaveEdit,
  onDelete,
  onMakeFlashcard,
}: {
  courseId: string;
  block: NoteBlockItem;
  busy: boolean;
  onSaveEdit: (title: string, content: string) => void;
  onDelete: () => void;
  onMakeFlashcard: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(block.title ?? "");
  const [editContent, setEditContent] = useState(block.content);

  function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editContent.trim()) return;
    onSaveEdit(editTitle.trim(), editContent.trim());
    setEditing(false);
  }

  return (
    <div
      data-testid={`note-block-${block.id}`}
      className="grid gap-2.5 rounded-md border border-line-subtle bg-surface-page p-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="neutral">
            {copy.blockTypes[block.block_type as keyof typeof copy.blockTypes] ?? block.block_type}
          </Badge>
          <BlockSourceBadge courseId={courseId} sourceRef={block.source_ref} />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            leftIcon={<Layers size={14} aria-hidden="true" />}
            onClick={onMakeFlashcard}
            data-testid={`flashcard-block-${block.id}`}
          >
            {copy.toFlashcard}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            leftIcon={<Pencil size={14} aria-hidden="true" />}
            onClick={() => {
              setEditTitle(block.title ?? "");
              setEditContent(block.content);
              setEditing((prev) => !prev);
            }}
          >
            {copy.editBlock}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            leftIcon={<Trash2 size={14} aria-hidden="true" />}
            onClick={onDelete}
          >
            {copy.deleteBlock}
          </Button>
        </div>
      </div>

      {editing ? (
        <form className="grid gap-2.5" onSubmit={submitEdit}>
          <TextInput
            value={editTitle}
            placeholder={copy.blockTitlePlaceholder}
            maxLength={120}
            onChange={(event) => setEditTitle(event.target.value)}
          />
          <Textarea
            value={editContent}
            rows={4}
            maxLength={8000}
            onChange={(event) => setEditContent(event.target.value)}
            required
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" size="sm" pending={busy} disabled={!editContent.trim()}>
              {t.common.save}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(false)}>
              {t.common.cancel}
            </Button>
          </div>
        </form>
      ) : (
        <BoardBlock
          block={toBoardBlock(block)}
          progressiveSteps={false}
          reducedMotion
          showTools
          labels={{
            renderError: t.classroom.boardRenderError,
            viewSource: t.classroom.boardViewSource,
            imageAlt: t.classroom.boardImageAlt,
            copy: t.classroom.boardCopy,
            copied: t.classroom.boardCopied,
            plotReset: t.classroom.boardPlotReset,
            plotPlay: t.classroom.boardPlotPlay,
            plotPause: t.classroom.boardPlotPause,
          }}
        />
      )}
    </div>
  );
}

export default function NotesPage() {
  const courseId = useParams().courseId ?? "";
  const queries = useQueryClient();
  const [selectedNoteId, setSelectedNoteId] = useState<string>("");
  const [newTitle, setNewTitle] = useState("");
  const [blockType, setBlockType] = useState("text");
  const [blockTitle, setBlockTitle] = useState("");
  const [blockContent, setBlockContent] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<NoteSuggestionItem[]>([]);
  const [suggestEmptyNotice, setSuggestEmptyNotice] = useState(false);

  const listQuery = useQuery({
    queryKey: notesKeys.list(courseId),
    queryFn: () => listCourseNotes(courseId),
    enabled: Boolean(courseId),
  });

  const activeNoteId =
    selectedNoteId && listQuery.data?.some((item) => item.id === selectedNoteId)
      ? selectedNoteId
      : (listQuery.data?.[0]?.id ?? "");

  const detailQuery = useQuery({
    queryKey: notesKeys.one(courseId, activeNoteId),
    queryFn: () => getCourseNote(courseId, activeNoteId),
    enabled: Boolean(courseId && activeNoteId),
  });

  function syncNote(detail: CourseNoteDetail) {
    queries.setQueryData(notesKeys.one(courseId, detail.id), detail);
    void queries.invalidateQueries({ queryKey: notesKeys.list(courseId), exact: true });
  }

  const createMutation = useMutation({
    mutationFn: () => createCourseNote(courseId, { title: newTitle.trim() }),
    onSuccess: (created) => {
      setNewTitle("");
      setSelectedNoteId(created.id);
      setSuggestions([]);
      setSuggestEmptyNotice(false);
      syncNote(created);
      toast.success(t.common.saved);
    },
  });

  const deleteNoteMutation = useMutation({
    mutationFn: (noteId: string) => deleteCourseNote(courseId, noteId),
    onSuccess: (_, noteId) => {
      setDeleteOpen(false);
      setSuggestions([]);
      queries.removeQueries({ queryKey: notesKeys.one(courseId, noteId), exact: true });
      if (selectedNoteId === noteId) setSelectedNoteId("");
      void queries.invalidateQueries({ queryKey: notesKeys.list(courseId), exact: true });
      toast.success(t.common.saved);
    },
  });

  const addBlockMutation = useMutation({
    mutationFn: (payload: { block_type: string; title?: string | null; content: string }) =>
      addNoteBlock(courseId, activeNoteId, payload),
    onSuccess: (updated) => {
      syncNote(updated);
    },
  });

  const updateBlockMutation = useMutation({
    mutationFn: ({ blockId, title, content }: { blockId: string; title: string; content: string }) =>
      updateNoteBlock(courseId, activeNoteId, blockId, { title, content }),
    onSuccess: (updated) => {
      syncNote(updated);
      toast.success(t.common.saved);
    },
  });

  const deleteBlockMutation = useMutation({
    mutationFn: (blockId: string) => deleteNoteBlock(courseId, activeNoteId, blockId),
    onSuccess: (updated) => {
      syncNote(updated);
      toast.success(t.common.saved);
    },
  });

  const suggestMutation = useMutation({
    mutationFn: () => suggestNoteAdditions(courseId, activeNoteId),
    onSuccess: (items) => {
      setSuggestions(items);
      setSuggestEmptyNotice(items.length === 0);
    },
  });

  const flashcardMutation = useMutation({
    mutationFn: (blockId: string) => createFlashcardFromNoteBlock(courseId, activeNoteId, blockId),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: courseKeys.dashboard });
      toast.success(copy.flashcardCreated);
    },
  });

  function handleCreateNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newTitle.trim()) return;
    createMutation.mutate();
  }

  function handleAddBlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!blockContent.trim() || !activeNoteId) return;
    addBlockMutation.mutate(
      {
        block_type: blockType,
        title: blockTitle.trim() || null,
        content: blockContent.trim(),
      },
      {
        onSuccess: () => {
          setBlockTitle("");
          setBlockContent("");
          toast.success(t.common.saved);
        },
      },
    );
  }

  function handleAcceptSuggestion(suggestion: NoteSuggestionItem) {
    addBlockMutation.mutate(
      {
        block_type: suggestion.block_type,
        title: suggestion.title || null,
        content: suggestion.content,
      },
      {
        onSuccess: () => {
          setSuggestions((prev) => prev.filter((item) => item.id !== suggestion.id));
          toast.success(copy.acceptedToast);
        },
      },
    );
  }

  if (listQuery.isPending) return <Loading />;
  if (listQuery.isError) return <Problem error={listQuery.error} onRetry={() => void listQuery.refetch()} />;

  const activeNote = detailQuery.data;

  return (
    <div className="grid min-w-0 gap-5" data-testid="notes-page">
      <div className="grid gap-1">
        <h2 className="text-title font-semibold text-fg-primary">{copy.heading}</h2>
        <p className="text-ui text-fg-secondary">{copy.lead}</p>
      </div>

      <div className="grid items-start gap-5 md:grid-cols-[minmax(220px,280px)_minmax(0,1fr)]">
        {/* Left sidebar: notebook list & create */}
        <Card padding="md" className="grid gap-4">
          <form className="grid gap-2" onSubmit={handleCreateNote}>
            <Field label={copy.newNote}>
              <TextInput
                value={newTitle}
                maxLength={120}
                placeholder={copy.newNoteTitlePlaceholder}
                onChange={(event) => setNewTitle(event.target.value)}
                data-testid="note-create-input"
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              pending={createMutation.isPending}
              disabled={!newTitle.trim()}
              leftIcon={<Plus size={14} aria-hidden="true" />}
              data-testid="note-create-btn"
            >
              {copy.createNote}
            </Button>
            {createMutation.isError ? <Problem error={createMutation.error} /> : null}
          </form>

          <div className="grid gap-1.5 border-t border-line-subtle pt-3">
            {listQuery.data.length === 0 ? (
              <p className="text-caption text-fg-secondary">{copy.emptyList}</p>
            ) : (
              listQuery.data.map((note) => {
                const selected = note.id === activeNoteId;
                return (
                  <button
                    key={note.id}
                    type="button"
                    data-testid={`note-nav-${note.id}`}
                    aria-current={selected ? "true" : undefined}
                    onClick={() => {
                      setSelectedNoteId(note.id);
                      setSuggestions([]);
                      setSuggestEmptyNotice(false);
                    }}
                    className={
                      selected
                        ? "flex min-h-10 items-center justify-between gap-2 rounded-md bg-accent-soft px-3 py-2 text-left text-ui font-medium text-accent-strong"
                        : "flex min-h-10 items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-ui text-fg-primary hover:bg-surface-sunken"
                    }
                  >
                    <span className="truncate">{note.title}</span>
                    <small className="shrink-0 text-caption text-fg-tertiary">
                      {copy.blockCount.replace("{count}", String(note.block_count))}
                    </small>
                  </button>
                );
              })
            )}
          </div>
        </Card>

        {/* Right main note editor */}
        <div className="grid min-w-0 gap-4">
          {!activeNoteId ? (
            <Card padding="lg">
              <EmptyState title={copy.heading} description={copy.emptyList} />
            </Card>
          ) : detailQuery.isPending ? (
            <Loading />
          ) : detailQuery.isError || !activeNote ? (
            <Problem error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />
          ) : (
            <>
              <Card padding="lg" className="grid gap-4">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line-subtle pb-3">
                  <div className="grid gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <FileText size={18} className="text-accent-strong" aria-hidden="true" />
                      <h3 className="text-title font-semibold text-fg-primary">{activeNote.title}</h3>
                      {activeNote.kp_name ? <Badge tone="neutral">{activeNote.kp_name}</Badge> : null}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      pending={suggestMutation.isPending}
                      disabled={activeNote.blocks.length === 0}
                      leftIcon={<Sparkles size={14} aria-hidden="true" />}
                      onClick={() => suggestMutation.mutate()}
                      data-testid="note-suggest-btn"
                    >
                      {suggestMutation.isPending ? copy.suggesting : copy.askSuggest}
                    </Button>
                    <a
                      href={noteExportUrl(courseId, activeNote.id, "md")}
                      download
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-line-control bg-surface-card px-2.5 text-caption font-medium text-fg-primary hover:bg-surface-sunken"
                    >
                      <Download size={14} aria-hidden="true" />
                      <span>{copy.exportMd}</span>
                    </a>
                    <a
                      href={noteExportUrl(courseId, activeNote.id, "anki_tsv")}
                      download
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-line-control bg-surface-card px-2.5 text-caption font-medium text-fg-primary hover:bg-surface-sunken"
                    >
                      <Download size={14} aria-hidden="true" />
                      <span>{copy.exportAnki}</span>
                    </a>
                    <Button
                      variant="ghost"
                      size="sm"
                      leftIcon={<Trash2 size={14} aria-hidden="true" />}
                      onClick={() => setDeleteOpen(true)}
                    >
                      {copy.deleteNote}
                    </Button>
                  </div>
                </div>

                {suggestMutation.isError ? <Problem error={suggestMutation.error} /> : null}
                {addBlockMutation.isError ? <Problem error={addBlockMutation.error} /> : null}
                {updateBlockMutation.isError ? <Problem error={updateBlockMutation.error} /> : null}
                {deleteBlockMutation.isError ? <Problem error={deleteBlockMutation.error} /> : null}
                {flashcardMutation.isError ? <Problem error={flashcardMutation.error} /> : null}

                {/* Read-only Dito-style Diff suggestion panel */}
                {suggestEmptyNotice && suggestions.length === 0 ? (
                  <p className="rounded-md bg-surface-page px-3.5 py-2.5 text-caption text-fg-secondary">
                    {copy.suggestEmpty}
                  </p>
                ) : null}
                {suggestions.length > 0 ? (
                  <section
                    data-testid="note-suggestions-panel"
                    className="grid gap-3 rounded-md border border-accent/35 bg-accent-soft/35 p-4"
                  >
                    <div className="flex items-center gap-2 text-ui font-semibold text-accent-strong">
                      <Sparkles size={15} aria-hidden="true" />
                      <span>{copy.suggestHeading}</span>
                    </div>
                    <div className="grid gap-3">
                      {suggestions.map((sug) => (
                        <div
                          key={sug.id}
                          data-testid={`note-suggestion-${sug.id}`}
                          className="grid gap-2.5 rounded-md border-l-[3px] border-l-accent bg-surface-card p-3.5 shadow-1"
                        >
                          {sug.reason ? (
                            <p className="m-0 text-caption font-medium text-fg-secondary">{sug.reason}</p>
                          ) : null}
                          <BoardBlock
                            block={toBoardBlock(sug)}
                            progressiveSteps={false}
                            reducedMotion
                            showTools={false}
                          />
                          <div className="flex flex-wrap items-center gap-2 pt-1">
                            <Button
                              variant="primary"
                              size="sm"
                              pending={addBlockMutation.isPending}
                              leftIcon={<Check size={14} aria-hidden="true" />}
                              onClick={() => handleAcceptSuggestion(sug)}
                              data-testid={`accept-suggestion-${sug.id}`}
                            >
                              {copy.acceptSuggest}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              leftIcon={<X size={14} aria-hidden="true" />}
                              onClick={() =>
                                setSuggestions((prev) => prev.filter((item) => item.id !== sug.id))
                              }
                              data-testid={`dismiss-suggestion-${sug.id}`}
                            >
                              {copy.dismissSuggest}
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                ) : null}

                {/* Blocks list */}
                {activeNote.blocks.length === 0 ? (
                  <p className="rounded-md bg-surface-page px-4 py-4 text-ui text-fg-secondary">
                    {copy.emptyBlocks}
                  </p>
                ) : (
                  <div className="grid gap-3">
                    {activeNote.blocks.map((blk) => (
                      <NoteBlockCard
                        key={blk.id}
                        courseId={courseId}
                        block={blk}
                        busy={
                          updateBlockMutation.isPending ||
                          deleteBlockMutation.isPending ||
                          flashcardMutation.isPending
                        }
                        onSaveEdit={(title, content) =>
                          updateBlockMutation.mutate({ blockId: blk.id, title, content })
                        }
                        onDelete={() => deleteBlockMutation.mutate(blk.id)}
                        onMakeFlashcard={() => flashcardMutation.mutate(blk.id)}
                      />
                    ))}
                  </div>
                )}
              </Card>

              {/* Add new block form */}
              <Card padding="lg" className="grid gap-3">
                <h4 className="text-ui font-semibold text-fg-primary">{copy.addBlockHeading}</h4>
                <form className="grid gap-3" onSubmit={handleAddBlock}>
                  <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
                    <Select
                      aria-label={copy.addBlockHeading}
                      value={blockType}
                      onValueChange={setBlockType}
                      options={BLOCK_TYPE_OPTIONS}
                    />
                    <TextInput
                      value={blockTitle}
                      maxLength={120}
                      placeholder={copy.blockTitlePlaceholder}
                      onChange={(event) => setBlockTitle(event.target.value)}
                      data-testid="note-block-title-input"
                    />
                  </div>
                  <Textarea
                    value={blockContent}
                    rows={4}
                    maxLength={8000}
                    placeholder={copy.blockContentPlaceholder}
                    onChange={(event) => setBlockContent(event.target.value)}
                    data-testid="note-block-content-input"
                    required
                  />
                  <div>
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      pending={addBlockMutation.isPending}
                      disabled={!blockContent.trim()}
                      leftIcon={<Plus size={14} aria-hidden="true" />}
                      data-testid="note-block-add-btn"
                    >
                      {copy.addBlock}
                    </Button>
                  </div>
                </form>
              </Card>

              <ConfirmDialog
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
                title={copy.deleteNoteTitle}
                description={copy.deleteNoteBody}
                confirmLabel={copy.deleteNote}
                cancelLabel={t.common.keep}
                pending={deleteNoteMutation.isPending}
                onConfirm={() => deleteNoteMutation.mutate(activeNote.id)}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
