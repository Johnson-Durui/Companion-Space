import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  bodyOf,
  charactersKey,
  fetchCharacters,
  fetchSettings,
  settingsKey,
  type Character,
} from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import { Button, Plus, Sparkles, toast } from "../../ui";
import t from "../../locales/zh-CN.json";
import { ImportTutorWizardDialog } from "./import-wizard";
import { TutorRoster, TutorShowcase } from "./tutor-showcase";
import { tutorGreeting } from "./use-active-tutor";

export default function TutorsGalleryPage() {
  const queries = useQueryClient();
  const roster = useQuery({ queryKey: charactersKey, queryFn: fetchCharacters });
  const settings = useQuery({ queryKey: settingsKey, queryFn: fetchSettings });

  const [focusedId, setFocusedId] = useState<string>();
  const [introSeq, setIntroSeq] = useState(0);
  const [chosenGreeting, setChosenGreeting] = useState("");
  const [chosenSpeakSeq, setChosenSpeakSeq] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);

  const choose = useMutation({
    mutationFn: async (character: Character) => {
      await bodyOf(
        await api.PUT("/api/v2/settings/default-character", {
          body: { character_id: character.id },
        }),
      );
      return character;
    },
    onSuccess: (character) => {
      void queries.invalidateQueries({ queryKey: settingsKey });
      toast.success(t.common.saved);
      const line = tutorGreeting(character);
      if (line) {
        setChosenGreeting(line);
        setChosenSpeakSeq((seq) => seq + 1);
      }
    },
  });

  if (roster.isPending || settings.isPending) return <Loading />;
  if (roster.isError) return <Problem error={roster.error} onRetry={() => void roster.refetch()} />;
  if (settings.isError) return <Problem error={settings.error} onRetry={() => void settings.refetch()} />;

  const characters = roster.data;
  const currentId = settings.data.default_character_id;
  const candidate =
    characters.find((entry) => entry.id === (focusedId ?? currentId)) ?? characters[0];

  if (!candidate) {
    return (
      <div className="grid gap-4 py-8">
        <h1 className="text-headline font-semibold text-fg-primary">{t.welcome.heading}</h1>
        <p className="text-ui text-fg-secondary">{t.welcome.empty}</p>
      </div>
    );
  }

  function handleSelectTile(entry: Character) {
    choose.reset();
    setChosenGreeting("");
    setFocusedId(entry.id);
    setIntroSeq((seq) => seq + 1);
  }

  return (
    <div className="grid min-w-0 gap-4 py-4 sm:py-5" data-testid="tutors-gallery-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-caption font-semibold text-accent-strong">
            <Sparkles size={13} aria-hidden="true" />
            <span>{t.richUi.tutorStudioKicker}</span>
          </span>
          <p className="text-ui text-fg-secondary">{t.richUi.tutorGalleryLead}</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Plus size={15} aria-hidden="true" />}
          onClick={() => {
            setDroppedFile(null);
            setImportOpen(true);
          }}
        >
          {t.tutorsGallery.importTile}
        </Button>
      </div>

      <TutorShowcase
        character={candidate}
        isCurrent={candidate.id === currentId}
        choosing={choose.isPending}
        headingLevel="h1"
        showEditLink
        introSeq={introSeq}
        chosenGreeting={chosenGreeting}
        chosenSpeakSeq={chosenSpeakSeq}
        onChoose={(entry) => choose.mutate(entry)}
      />

      {choose.isError ? <Problem error={choose.error} /> : null}

      <TutorRoster
        characters={characters}
        selectedId={candidate.id}
        currentId={currentId}
        onSelect={handleSelectTile}
        showImportTile
        onOpenImport={() => {
          setDroppedFile(null);
          setImportOpen(true);
        }}
        onDropImportFile={(file) => {
          setDroppedFile(file);
          setImportOpen(true);
        }}
      />

      <ImportTutorWizardDialog
        open={importOpen}
        onOpenChange={(next) => {
          setImportOpen(next);
          if (!next) setDroppedFile(null);
        }}
        initialFile={droppedFile}
        onFinished={(created) => {
          setFocusedId(created.id);
          setChosenGreeting(tutorGreeting(created));
        }}
      />
    </div>
  );
}
