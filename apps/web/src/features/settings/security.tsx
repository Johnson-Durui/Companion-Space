import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, bodyOf, sessionKey, type SessionStatus } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import t from "../../locales/zh-CN.json";

export function UnlockSession({ session }: { session: SessionStatus }) {
  const queryClient = useQueryClient();
  const migration = session.state === "migration_required";
  const action = useMutation({
    mutationFn: async (password: string | null) => (
      password === null ? bodyOf(await api.POST("/api/v2/session/skip-migration")) :
      bodyOf(await api.POST("/api/v2/session/unlock", { body: { password } }))
    ),
    onSuccess: (status) => queryClient.setQueryData(sessionKey, status),
  });
  function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const password = String(new FormData(form).get("password") ?? "");
    action.mutate(password, { onSettled: () => form.reset() });
  }
  return (
    <div className="unlock-box">
      <div>
        <h1>{migration ? t.security.migration : t.security.locked}</h1>
        {migration ? <p className="hint">{t.security.migrationHint}</p> : null}
      </div>
      <form className="fields" onSubmit={unlock}>
        <label>{t.security.password}<input autoComplete="current-password" name="password" type="password" maxLength={200} required /></label>
        <div className="actions">
          <button className="button primary" disabled={action.isPending} aria-busy={action.isPending || undefined}>{migration ? t.security.migrate : t.security.unlock}</button>
          {migration ? (
            <button className="button quiet" type="button" disabled={action.isPending} aria-busy={action.isPending || undefined} onClick={() => {
              if (window.confirm(t.security.skipConfirm)) action.mutate(null);
            }}>{t.security.skipMigration}</button>
          ) : null}
        </div>
      </form>
      {action.isError ? <Problem error={action.error} /> : null}
    </div>
  );
}

const securityKey = ["security"] as const;

export function SecuritySettings() {
  const queries = useQueryClient();
  const [validation, setValidation] = useState("");
  const status = useQuery({
    queryKey: securityKey,
    queryFn: async () => bodyOf(await api.GET("/api/v2/settings/security")),
  });
  const update = useMutation({
    mutationFn: async (body: { password: string | null; current_password?: string }) => bodyOf(await api.PUT("/api/v2/settings/security/password", { body })),
    onSuccess: (session) => {
      queries.setQueryData(securityKey, session);
      queries.setQueryData(sessionKey, session);
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
          <button className="button primary" name="action" value="enable" disabled={update.isPending} aria-busy={update.isPending || undefined}>{enabled ? t.security.change : t.security.enable}</button>
          {enabled ? <button className="button quiet" name="action" value="disable" disabled={update.isPending} aria-busy={update.isPending || undefined}>{t.security.disable}</button> : null}
          {update.isSuccess ? <span role="status" className="form-success">{t.common.saved}</span> : null}
        </div>
        {validation ? <p role="alert" className="hint">{validation}</p> : null}
        {update.isError ? <Problem error={update.error} /> : null}
      </form>
    </>
  );
}
