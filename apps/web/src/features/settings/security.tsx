import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, bodyOf, charactersKey, sessionKey, type Character, type SessionStatus } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import { FocusShell } from "../../shell/FocusShell";
import { BrandMark, Button, Card, Check, ConfirmDialog, Field, SecretInput, TutorAvatar, useTransientSaved } from "../../ui";
import t from "../../locales/zh-CN.json";

export function UnlockSession({ session }: { session: SessionStatus }) {
  const queryClient = useQueryClient();
  const [skipOpen, setSkipOpen] = useState(false);
  const [password, setPassword] = useState("");
  const migration = session.state === "migration_required";
  const cachedCharacters = queryClient.getQueryData<Character[]>(charactersKey);
  const cachedTeacher = cachedCharacters?.[0] ?? null;

  const action = useMutation({
    mutationFn: async (pwd: string | null) => (
      pwd === null ? bodyOf(await api.POST("/api/v2/session/skip-migration")) :
      bodyOf(await api.POST("/api/v2/session/unlock", { body: { password: pwd } }))
    ),
    onSuccess: (status) => {
      setSkipOpen(false);
      setPassword("");
      queryClient.setQueryData(sessionKey, status);
    },
  });
  function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    action.mutate(password, { onSettled: () => setPassword("") });
  }
  return (
    <FocusShell flowName={t.app.name} exitTo="/" exitLabel={t.app.refresh} onExit={() => window.location.reload()}>
      <div className="mx-auto grid max-w-md py-10" data-testid="unlock-screen">
        <Card padding="lg" className="grid gap-5">
          <div className="grid justify-items-center gap-3 text-center">
            {cachedTeacher ? (
              <TutorAvatar src={cachedTeacher.appearance.src} name={cachedTeacher.name} size="xl" />
            ) : (
              <BrandMark size={48} />
            )}
            <div className="grid gap-1">
              <h1 className="text-headline font-semibold text-fg-primary">
                {migration ? t.security.migration : t.security.locked}
              </h1>
              <p className="text-body text-fg-secondary">
                {migration ? t.security.migrationHint : t.tutorsGallery.unlockPrompt}
              </p>
            </div>
          </div>

          <form className="grid gap-4" onSubmit={unlock}>
            <Field label={t.security.password} required>
              <SecretInput
                autoComplete="current-password"
                name="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                maxLength={200}
                required
                autoFocus
              />
            </Field>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {migration ? (
                <Button variant="secondary" disabled={action.isPending} onClick={() => setSkipOpen(true)}>
                  {t.security.skipMigration}
                </Button>
              ) : null}
              <Button type="submit" variant="primary" pending={action.isPending}>
                {migration ? t.security.migrate : t.security.unlock}
              </Button>
            </div>
          </form>

          <ConfirmDialog
            open={skipOpen}
            onOpenChange={setSkipOpen}
            title={t.security.skipTitle}
            description={t.security.skipConfirm}
            confirmLabel={t.security.confirmSkip}
            cancelLabel={t.common.cancel}
            pending={action.isPending}
            onConfirm={() => action.mutate(null)}
          />
          {action.isError ? <Problem error={action.error} /> : null}
        </Card>
      </div>
    </FocusShell>
  );
}

const securityKey = ["security"] as const;

export function SecuritySettings() {
  const queries = useQueryClient();
  const [validation, setValidation] = useState("");
  const { saved, notifySaved } = useTransientSaved(t.common.saved);
  const status = useQuery({
    queryKey: securityKey,
    queryFn: async () => bodyOf(await api.GET("/api/v2/settings/security")),
  });
  const update = useMutation({
    mutationFn: async (body: { password: string | null; current_password?: string }) => bodyOf(await api.PUT("/api/v2/settings/security/password", { body })),
    onSuccess: (session) => {
      queries.setQueryData(securityKey, session);
      queries.setQueryData(sessionKey, session);
      notifySaved();
    },
  });
  if (status.isPending) return <Loading />;
  if (status.isError) return <Problem error={status.error} onRetry={() => void status.refetch()} />;
  const enabled = status.data.password_enabled;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidation("");
    update.reset();
    const form = event.currentTarget;
    const data = new FormData(form, event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null);
    const current = String(data.get("current") ?? "");
    const password = String(data.get("password") ?? "");
    const confirmation = String(data.get("confirmation") ?? "");
    const disabling = data.get("action") === "disable";
    if (!disabling && ([...password].length < 8 || [...password].length > 200)) {
      setValidation(t.security.passwordLength);
      return;
    }
    if (!disabling && password !== confirmation) {
      setValidation(t.security.mismatch);
      return;
    }
    update.mutate({ password: disabling ? null : password, ...(enabled ? { current_password: current } : {}) }, {
      onSuccess: () => form.reset(),
    });
  }
  const storage = status.data.key_storage;

  return (
    <>
      <p>{enabled ? t.security.passwordOn : t.security.passwordOff}</p>
      {storage === "key_file" ? <p className="notice" role="status">{t.security.keyfile}</p> : null}
      {storage === "credential_store" ? <p className="hint">{t.security.keyring}</p> : null}
      <form className="fields" onSubmit={submit}>
        {enabled ? <label>{t.security.current}<input autoComplete="current-password" name="current" type="password" maxLength={200} required /></label> : null}
        <div className="field-row">
          <label>{t.security.newPassword}<input autoComplete="new-password" name="password" type="password" required={!enabled} /></label>
          <label>{t.security.confirm}<input autoComplete="new-password" name="confirmation" type="password" required={!enabled} /></label>
        </div>
        <div className="actions">
          <Button type="submit" variant="primary" name="action" value="enable" pending={update.isPending}>{enabled ? t.security.change : t.security.enable}</Button>
          {enabled ? <Button type="submit" variant="secondary" name="action" value="disable" pending={update.isPending}>{t.security.disable}</Button> : null}
          {saved ? <span className="inline-flex items-center gap-1 text-ui font-medium text-ok-text"><Check size={15} aria-hidden="true" />{t.common.saved}</span> : null}
        </div>
        {validation ? <p role="alert" className="hint">{validation}</p> : null}
        {update.isError ? <Problem error={update.error} /> : null}
      </form>
    </>
  );
}
