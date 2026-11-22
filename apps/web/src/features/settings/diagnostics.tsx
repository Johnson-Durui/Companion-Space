import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { create } from "zustand";
import clsx from "clsx";
import { api, ensureOK, fetchRoles, rolesKey, type ChatInput } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import { Button, Card, Field, Textarea } from "../../ui";
import t from "../../locales/zh-CN.json";
import { readDiagnosticStream } from "./chat-stream";

type Exchange = { message: string; imageName?: string; answer: string; completed: boolean };
type Conversation = { turns: Exchange[]; waiting: boolean };

const useConversation = create<Conversation>(() => ({ turns: [], waiting: false }));
const acceptedImages = ["image/jpeg", "image/png", "image/webp"];
const imageLimit = 5 * 1024 * 1024;

function updateLast(augment: (turn: Exchange) => Exchange) {
  useConversation.setState(({ turns }) => {
    const last = turns.at(-1);
    return last ? { turns: [...turns.slice(0, -1), augment(last)] } : { turns };
  });
}

async function readImage(image: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = typeof reader.result === "string" ? reader.result.split(",", 2)[1] : undefined;
      if (data) resolve(data);
      else reject(new Error(t.diagnostics.uploadError));
    };
    reader.onerror = () => reject(new Error(t.diagnostics.uploadError));
    reader.readAsDataURL(image);
  });
}

function Dialogue() {
  const turns = useConversation((state) => state.turns);
  const waiting = useConversation((state) => state.waiting);
  return (
    <section
      className="grid min-h-[180px] content-start gap-4 rounded-md border border-line-subtle bg-surface-page p-4"
      aria-label={t.diagnostics.label}
      aria-busy={waiting}
    >
      {!turns.length ? <p className="text-ui text-fg-secondary">{t.diagnostics.empty}</p> : null}
      {turns.map((turn, index) => (
        <div key={index} className="grid gap-3">
          <article className="max-w-[90%] justify-self-end grid gap-1" data-user="true">
            <strong className="text-right text-caption font-semibold text-accent-strong">
              {t.diagnostics.you}
            </strong>
            <p className="whitespace-pre-wrap break-words rounded-md bg-accent-soft px-3.5 py-2 text-ui text-fg-primary">
              {turn.message}
              {turn.imageName ? (
                <small className="mt-1 block text-caption text-fg-secondary">{turn.imageName}</small>
              ) : null}
            </p>
          </article>
          {turn.answer ? (
            <article className="max-w-[90%] justify-self-start grid gap-1">
              <strong className="text-caption font-semibold text-accent-strong">
                {t.diagnostics.teacher}
              </strong>
              <p
                data-testid="reply"
                className="whitespace-pre-wrap break-words rounded-md border border-line-subtle bg-surface-card px-3.5 py-2 text-ui text-fg-primary"
              >
                {turn.answer}
              </p>
            </article>
          ) : null}
        </div>
      ))}
      {waiting ? (
        <p className="text-ui text-fg-secondary" role="status">
          {t.diagnostics.waiting}
        </p>
      ) : null}
    </section>
  );
}

export function DiagnosticsPanel({
  embedded = false,
  onOpenConnect,
}: {
  embedded?: boolean;
  onOpenConnect?: () => void;
}) {
  const assignment = useQuery({ queryKey: rolesKey, queryFn: fetchRoles });
  const queries = useQueryClient();
  const [messageText, setMessageText] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const waiting = useConversation((state) => state.waiting);
  const [image, setImage] = useState<File | null>(null);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  useEffect(() => () => { request.current?.abort(); }, []);

  function attach(fileToAttach: File | undefined) {
    setError(undefined);
    setImage(null);
    if (!fileToAttach) return;
    if (!acceptedImages.includes(fileToAttach.type) || fileToAttach.size > imageLimit) {
      if (file.current) file.current.value = "";
      setError(
        new Error(
          acceptedImages.includes(fileToAttach.type)
            ? t.diagnostics.uploadSize
            : t.diagnostics.uploadType,
        ),
      );
      return;
    }
    setImage(fileToAttach);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current || useConversation.getState().waiting) return;
    const attached = image;
    const message = messageText.trim() || (attached ? t.diagnostics.imageOnly : "");
    if (!message) return;
    if (!assignment.data?.[attached ? "vision" : "live"]) {
      setError(new Error(t.diagnostics.needRole));
      return;
    }
    const previous = useConversation.getState().turns;
    const history: NonNullable<ChatInput["history"]> = previous
      .filter((turn) => turn.completed)
      .slice(-6)
      .flatMap((turn) => [
        { role: "user" as const, content: turn.message.slice(0, 4000) },
        { role: "assistant" as const, content: turn.answer.slice(0, 4000) },
      ]);
    const controller = new AbortController();
    request.current = controller;
    setError(undefined);
    setNotice("");
    useConversation.setState({
      turns: [...previous, { message, imageName: attached?.name, answer: "", completed: false }],
      waiting: true,
    });
    setMessageText("");
    if (file.current) file.current.value = "";
    setImage(null);

    try {
      const body: ChatInput = { message, history };
      if (attached) {
        body.image = {
          mime: attached.type as "image/png" | "image/jpeg" | "image/webp",
          data_b64: await readImage(attached),
        };
      }
      const { response, error: serverError } = await api.POST("/api/v2/diagnostics/chat", {
        body,
        signal: controller.signal,
        parseAs: "stream",
      });
      ensureOK(response, serverError);
      if (!response.body) throw new Error(t.diagnostics.streamError);
      await readDiagnosticStream(response.body, (text) =>
        updateLast((turn) => ({ ...turn, answer: turn.answer + text })),
      );
      updateLast((turn) => ({ ...turn, completed: true }));
      void queries.invalidateQueries({ queryKey: ["usage"] });
    } catch (failure) {
      if (controller.signal.aborted) setNotice(t.diagnostics.partial);
      else setError(failure);
    } finally {
      request.current = null;
      useConversation.setState({ waiting: false });
    }
  }

  const configured = Boolean(assignment.data?.live || assignment.data?.vision);

  return (
    <Card
      padding="lg"
      data-testid="diagnostics-panel"
      className={clsx("grid gap-4", !embedded && "mx-auto max-w-3xl")}
    >
      <div className="grid gap-1 border-b border-line-subtle pb-3">
        {embedded ? (
          <h3 className="text-body font-semibold text-fg-primary">{t.diagnostics.heading}</h3>
        ) : (
          <h1 className="text-headline font-semibold text-fg-primary">{t.diagnostics.heading}</h1>
        )}
        <p className="text-ui text-fg-secondary">{t.diagnostics.intro}</p>
      </div>

      {assignment.isPending ? <Loading /> : null}
      {assignment.isError ? (
        <Problem error={assignment.error} onRetry={() => void assignment.refetch()} />
      ) : null}

      {assignment.data && !configured ? (
        <div className="grid justify-items-start gap-3 rounded-md border border-line-subtle bg-surface-page p-4">
          <p className="text-ui text-fg-secondary">{t.diagnostics.configuration}</p>
          {onOpenConnect ? (
            <Button variant="primary" onClick={onOpenConnect}>
              {t.diagnostics.connect}
            </Button>
          ) : (
            <Link
              to="/settings/ai"
              className="inline-flex min-h-10 items-center rounded-md bg-accent px-4 text-ui font-medium text-on-accent hover:bg-accent-strong"
            >
              {t.diagnostics.connect}
            </Link>
          )}
        </div>
      ) : null}

      {configured ? (
        <>
          <Dialogue />
          <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
            <Field label={t.diagnostics.input}>
              <Textarea
                name="message"
                rows={3}
                maxLength={4000}
                value={messageText}
                placeholder={t.diagnostics.placeholder}
                disabled={waiting}
                onChange={(event) => setMessageText(event.target.value)}
              />
            </Field>
            <div className="grid gap-1.5">
              <div className="flex flex-wrap items-center gap-3">
                <label className="grid gap-1 text-ui font-medium text-fg-primary">
                  <span>{t.diagnostics.image}</span>
                  <input
                    ref={file}
                    name="image"
                    type="file"
                    accept={acceptedImages.join(",")}
                    disabled={waiting}
                    aria-describedby="upload-hint"
                    onChange={(event) => attach(event.target.files?.[0])}
                    className="text-ui text-fg-secondary file:mr-3 file:rounded-sm file:border file:border-line-default file:bg-surface-sunken file:px-3 file:py-1.5 file:text-ui file:font-medium file:text-fg-primary"
                  />
                </label>
                {image ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setImage(null);
                      if (file.current) file.current.value = "";
                    }}
                  >
                    {t.diagnostics.removeImage}
                  </Button>
                ) : null}
              </div>
              <p id="upload-hint" className="text-caption text-fg-tertiary">
                {t.diagnostics.uploadHint}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {waiting ? (
                <Button variant="secondary" onClick={() => request.current?.abort()}>
                  {t.common.stop}
                </Button>
              ) : (
                <Button type="submit" variant="primary">
                  {t.common.send}
                </Button>
              )}
              <Button
                variant="secondary"
                disabled={waiting}
                onClick={() => {
                  useConversation.setState({ turns: [] });
                  setError(undefined);
                  setNotice("");
                }}
              >
                {t.diagnostics.clear}
              </Button>
            </div>
            {notice ? (
              <p role="status" className="text-ui text-fg-secondary">
                {notice}
              </p>
            ) : null}
            {error !== undefined ? <Problem error={error} /> : null}
          </form>
        </>
      ) : null}
    </Card>
  );
}

export default function Diagnostics() {
  return <DiagnosticsPanel />;
}
