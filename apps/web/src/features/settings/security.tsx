import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, bodyOf, charactersKey, sessionKey, type Character, type SessionStatus } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import { FocusShell } from "../../shell/FocusShell";
import {
  Badge,
  BrandMark,
  Button,
  Card,
  Check,
  ConfirmDialog,
  Field,
  SecretInput,
  TutorAvatar,
  useTransientSaved,
} from "../../ui";
import t from "../../locales/zh-CN.json";
import { resolveCharacterStill } from "../characters/video-config";

export function UnlockSession({ session }: { session: SessionStatus }) {
  const queryClient = useQueryClient();
  const [skipOpen, setSkipOpen] = useState(false);
  const [password, setPassword] = useState("");
  const migration = session.state === "migration_required";
  const cachedCharacters = queryClient.getQueryData<Character[]>(charactersKey);
  const cachedTeacher = cachedCharacters?.[0] ?? null;

  const action = useMutation({
    mutationFn: async (pwd: string | null) =>
      pwd === null
        ? bodyOf(await api.POST("/api/v2/session/skip-migration"))
        : bodyOf(await api.POST("/api/v2/session/unlock", { body: { password: pwd } })),
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
    <FocusShell
      flowName={t.app.name}
      exitTo="/"
      exitLabel={t.app.refresh}
      onExit={() => window.location.reload()}
    >
      <div className="mx-auto grid max-w-md py-10" data-testid="unlock-screen">
        <Card padding="lg" className="grid gap-5">
          <div className="grid justify-items-center gap-3 text-center">
            {cachedTeacher ? (() => {
              const unlockStill = resolveCharacterStill(cachedTeacher, "unlock");
              return (
                <TutorAvatar
                  src={unlockStill.url}
                  still={unlockStill.still}
                  name={cachedTeacher.name}
                  size="xl"
                />
              );
            })() : (
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
                <Button
                  variant="secondary"
                  disabled={action.isPending}
                  onClick={() => setSkipOpen(true)}
                >
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
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [validation, setValidation] = useState("");
  const { saved, notifySaved } = useTransientSaved(t.common.saved);

  const status = useQuery({
    queryKey: securityKey,
    queryFn: async () => bodyOf(await api.GET("/api/v2/settings/security")),
  });
  const update = useMutation({
    mutationFn: async (body: { password: string | null; current_password?: string }) =>
      bodyOf(await api.PUT("/api/v2/settings/security/password", { body })),
    onSuccess: (session) => {
      queries.setQueryData(securityKey, session);
      queries.setQueryData(sessionKey, session);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      notifySaved();
    },
  });

  if (status.isPending) return <Loading />;
  if (status.isError) return <Problem error={status.error} onRetry={() => void status.refetch()} />;

  const enabled = status.data.password_enabled;
  const storage = status.data.key_storage;

  function submit(disabling: boolean) {
    setValidation("");
    update.reset();
    if (!disabling && ([...newPassword].length < 8 || [...newPassword].length > 200)) {
      setValidation(t.security.passwordLength);
      return;
    }
    if (!disabling && newPassword !== confirmPassword) {
      setValidation(t.security.mismatch);
      return;
    }
    update.mutate({
      password: disabling ? null : newPassword,
      ...(enabled ? { current_password: currentPassword } : {}),
    });
  }

  return (
    <Card padding="lg" className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-subtle pb-3">
        <div className="grid gap-0.5">
          <h3 className="text-body font-semibold text-fg-primary">{t.security.title}</h3>
          <p className="text-ui text-fg-secondary">
            {enabled ? t.security.passwordOn : t.security.passwordOff}
          </p>
        </div>
        <Badge tone={enabled ? "ok" : "neutral"}>
          {enabled ? t.security.enable : t.security.disable}
        </Badge>
      </div>

      {storage === "key_file" ? (
        <p className="rounded-md border border-warn/30 bg-warn-soft px-3.5 py-2.5 text-ui text-warn-text" role="status">
          {t.security.keyfile}
        </p>
      ) : null}
      {storage === "credential_store" ? (
        <p className="text-caption text-fg-secondary">{t.security.keyring}</p>
      ) : null}

      <form
        className="grid max-w-2xl gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit(false);
        }}
      >
        {enabled ? (
          <Field label={t.security.current} required>
            <SecretInput
              autoComplete="current-password"
              name="current"
              value={currentPassword}
              maxLength={200}
              required
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </Field>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.security.newPassword} required={!enabled} error={validation || undefined}>
            <SecretInput
              autoComplete="new-password"
              name="password"
              value={newPassword}
              required={!enabled}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </Field>
          <Field label={t.security.confirm} required={!enabled}>
            <SecretInput
              autoComplete="new-password"
              name="confirmation"
              value={confirmPassword}
              required={!enabled}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button type="submit" variant="primary" pending={update.isPending}>
            {enabled ? t.security.change : t.security.enable}
          </Button>
          {enabled ? (
            <Button
              variant="secondary"
              pending={update.isPending}
              onClick={() => submit(true)}
            >
              {t.security.disable}
            </Button>
          ) : null}
          {saved ? (
            <span className="inline-flex items-center gap-1 text-ui font-medium text-ok-text">
              <Check size={15} aria-hidden="true" />
              {t.common.saved}
            </span>
          ) : null}
        </div>
        {update.isError ? <Problem error={update.error} /> : null}
      </form>
    </Card>
  );
}
