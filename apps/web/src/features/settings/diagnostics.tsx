import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { create } from "zustand";
import { api, ensureOK, fetchRoles, rolesKey, type ChatInput } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
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
    <section className="dialogue" aria-label={t.diagnostics.label} aria-busy={waiting}>
      {!turns.length ? <p className="hint">{t.diagnostics.empty}</p> : null}
      {turns.map((turn, index) => (
        <div key={index} className="exchange">
          <article className="message" data-user="true">
            <strong className="message-title">{t.diagnostics.you}</strong>
            <p>{turn.message}{turn.imageName ? <small className="message-attachment">{turn.imageName}</small> : null}</p>
          </article>
          {turn.answer ? (
            <article className="message">
              <strong className="message-title">{t.diagnostics.teacher}</strong>
              <p data-testid="reply">{turn.answer}</p>
            </article>
          ) : null}
        </div>
      ))}
      {waiting ? <p className="hint" role="status">{t.diagnostics.waiting}</p> : null}
    </section>
  );
}

export default function Diagnostics() {
  const assignment = useQuery({ queryKey: rolesKey, queryFn: fetchRoles });
  const queries = useQueryClient();
  const input = useRef<HTMLTextAreaElement>(null);
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
      setError(new Error(acceptedImages.includes(fileToAttach.type) ? t.diagnostics.uploadSize : t.diagnostics.uploadType));
      return;
    }
    setImage(fileToAttach);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current || useConversation.getState().waiting) return;
    const attached = image;
    const message = input.current?.value.trim() || (attached ? t.diagnostics.imageOnly : "");
    if (!message) return;
    if (!assignment.data?.[attached ? "vision" : "live"]) {
      setError(new Error(t.diagnostics.needRole));
      return;
    }
    const previous = useConversation.getState().turns;
    const history: NonNullable<ChatInput["history"]> = previous.filter((turn) => turn.completed).slice(-6).flatMap((turn) => [
      { role: "user" as const, content: turn.message.slice(0, 4000) },
      { role: "assistant" as const, content: turn.answer.slice(0, 4000) },
    ]);
    const controller = new AbortController();
    request.current = controller;
    setError(undefined);
    setNotice("");
    useConversation.setState({ turns: [...previous, { message, imageName: attached?.name, answer: "", completed: false }], waiting: true });
    if (input.current) input.current.value = "";
    if (file.current) file.current.value = "";
    setImage(null);

    try {
      const body: ChatInput = { message, history };
      if (attached) body.image = { mime: attached.type as "image/png" | "image/jpeg" | "image/webp", data_b64: await readImage(attached) };
      const { response, error: serverError } = await api.POST("/api/v2/diagnostics/chat", { body, signal: controller.signal, parseAs: "stream" });
      ensureOK(response, serverError);
      if (!response.body) throw new Error(t.diagnostics.streamError);
      await readDiagnosticStream(response.body, (text) => updateLast((turn) => ({ ...turn, answer: turn.answer + text })));
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
    <div className="diagnostics-page">
      <div className="page-title"><h1>{t.diagnostics.heading}</h1><p>{t.diagnostics.intro}</p></div>
      {assignment.isPending ? <Loading /> : null}
      {assignment.isError ? <Problem error={assignment.error} onRetry={() => void assignment.refetch()} /> : null}
      {assignment.data && !configured ? (
        <div className="dialogue instructions">
          <p>{t.diagnostics.configuration}</p>
          <Link to="/settings" className="button primary">{t.diagnostics.connect}</Link>
        </div>
      ) : null}
      {configured ? (
        <>
          <Dialogue />
          <form className="message-form" onSubmit={(event) => void submit(event)}>
            <label className="field">{t.diagnostics.input}<textarea ref={input} name="message" rows={3} maxLength={4000} placeholder={t.diagnostics.placeholder} disabled={waiting} /></label>
            <div className="attachment">
              <label className="field">{t.diagnostics.image}
                <input ref={file} name="image" type="file" accept={acceptedImages.join(",")} disabled={waiting} aria-describedby="upload-hint" onChange={(event) => attach(event.target.files?.[0])} />
              </label>
              {image ? <button type="button" className="button quiet" onClick={() => { setImage(null); if (file.current) file.current.value = ""; }}>{t.diagnostics.removeImage}</button> : null}
              <p id="upload-hint" className="hint">{t.diagnostics.uploadHint}</p>
            </div>
            <div className="request-actions">
              {waiting ? <button type="button" className="button quiet" onClick={() => request.current?.abort()}>{t.common.stop}</button> : <button className="button primary">{t.common.send}</button>}
              <button type="button" className="button quiet" disabled={waiting} onClick={() => {
                useConversation.setState({ turns: [] }); setError(undefined); setNotice("");
              }}>{t.diagnostics.clear}</button>
            </div>
            {notice ? <p role="status" className="hint">{notice}</p> : null}
            {error !== undefined ? <Problem error={error} /> : null}
          </form>
        </>
      ) : null}
    </div>
  );
}
