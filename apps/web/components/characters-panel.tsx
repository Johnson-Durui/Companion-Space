"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ChangeEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  createCharacter,
  deleteCharacter,
  downloadCharacterPack,
  duplicateCharacter,
  getOwnerPreferences,
  importCharacter,
  listCharacters,
} from "@/lib/api";
import { formatDateTime, joinCompact } from "@/lib/format";
import type { CharacterPackSummary } from "@/lib/types";
import {
  CharacterWorkshop,
  createCharacterWorkshopSeed,
  workshopRecipeToCharacterRecipe,
  type CharacterWorkshopDraft,
} from "@/components/character-workshop";
import {
  EmptyState,
  ErrorCallout,
  LoadingState,
  SectionCard,
  StatusBadge,
} from "@/components/ui";

import styles from "./characters-panel.module.css";

export function CharactersPanel() {
  const router = useRouter();
  const [characters, setCharacters] = useState<CharacterPackSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adultRelationshipsEnabled, setAdultRelationshipsEnabled] = useState(false);
  const [composerVersion, setComposerVersion] = useState(0);
  const packInputRef = useRef<HTMLInputElement | null>(null);
  const newCharacterRef = useRef<HTMLDetailsElement | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [next, preferences] = await Promise.all([
        listCharacters(),
        getOwnerPreferences(),
      ]);
      setCharacters(next);
      setAdultRelationshipsEnabled(preferences.adult_relationships_enabled);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "角色列表加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    function openLinkedComposer() {
      if (window.location.hash === "#new-character") {
        newCharacterRef.current?.setAttribute("open", "");
      }
    }

    openLinkedComposer();
    window.addEventListener("hashchange", openLinkedComposer);
    return () => window.removeEventListener("hashchange", openLinkedComposer);
  }, []);

  async function handleCreate(draft: CharacterWorkshopDraft) {
    setBusy(true);
    try {
      const created = await createCharacter({
        name: draft.name,
        description: draft.description,
        recipe: workshopRecipeToCharacterRecipe(draft.recipe),
      });
      setNotice(`已创建 ${created.name}。继续编辑请进入角色库中的详情页。`);
      setComposerVersion((value) => value + 1);
      await refresh();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "创建角色失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleDuplicate(characterId: string) {
    setBusy(true);
    try {
      const copy = await duplicateCharacter(characterId);
      setNotice(`已复制 ${copy.name}。`);
      await refresh();
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "复制角色失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(characterId: string) {
    setBusy(true);
    try {
      await deleteCharacter(characterId);
      setNotice("角色已删除。");
      await refresh();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "删除角色失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleExport(character: CharacterPackSummary) {
    setBusy(true);
    try {
      const blob = await downloadCharacterPack(character.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${character.name}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice(`已导出 ${character.name}。`);
      setError(null);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "导出角色失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setBusy(true);
    setImportError(null);
    try {
      const imported = await importCharacter(file);
      setError(null);
      router.push(`/characters/${imported.id}`);
    } catch (importError) {
      setImportError(importError instanceof Error ? importError.message : "导入角色失败");
    } finally {
      event.target.value = "";
      setBusy(false);
    }
  }

  const composerSeed = useMemo(() => createCharacterWorkshopSeed(), []);

  return (
    <section className={`${styles.page} page-stack`}>
      <header className={styles.intro}>
        <div>
          <span className={styles.kicker}>角色档案</span>
          <h1>学习伙伴</h1>
        </div>
        <p>先从档案里选一位同行者。需要时再创建新角色，或导入外部角色包。</p>
      </header>

      {error && !characters.length ? <ErrorCallout message={error} /> : null}
      {notice ? <div className="success-callout" role="status">{notice}</div> : null}

      <section className={styles.directory} aria-labelledby="saved-companions">
        <div className={styles.sectionHeading}>
          <h2 id="saved-companions">已保存的伙伴</h2>
          {!loading && characters.length ? <span>{characters.length} 位</span> : null}
        </div>

        {loading ? (
          <LoadingState label="正在读取角色..." />
        ) : characters.length ? (
          <div className={styles.roster}>
            {characters.map((character, index) => (
              <article
                key={character.id}
                className={`${styles.companionRow} ${index === 0 ? styles.featured : ""} info-card`}
              >
                {index === 0 ? (
                  <div className={styles.dossierStage} aria-hidden="true">
                    <span className={`app-pet-portrait ${styles.heroPet}`} />
                    <span className={styles.stageCaption}>CURRENT COMPANION</span>
                  </div>
                ) : null}
                <div className={styles.companionMain}>
                  {index === 0 ? <span className={styles.currentLabel}>当前档案</span> : null}
                  <div className={styles.titleRow}>
                    <Link href={`/characters/${character.id}`} className={styles.companionTitle}>
                      <strong>{character.name}</strong>
                    </Link>
                    <StatusBadge label={character.visibility || "private"} tone="muted" />
                  </div>
                  <p className={styles.blurb}>
                    {joinCompact([character.style || null, character.archetype || null]) || "等待补全配方"}
                  </p>
                  <p className={styles.updated}>更新于 {formatDateTime(character.updated_at)}</p>
                </div>
                <div className={styles.actions}>
                  <Link href={`/characters/${character.id}`} className={index === 0 ? "primary-button" : "ghost-button subtle-link"}>
                    进入详情
                  </Link>
                  <button type="button" className="ghost-button" disabled={busy} onClick={() => void handleDuplicate(character.id)}>
                    复制
                  </button>
                  <button type="button" className="ghost-button" disabled={busy} onClick={() => void handleExport(character)}>
                    导出
                  </button>
                  <button type="button" className="ghost-button danger-button" disabled={busy} onClick={() => void handleDelete(character.id)}>
                    删除
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : error ? (
          <ErrorCallout message={error} />
        ) : (
          <EmptyState title="角色库还是空的" description="展开下方的“创建新角色”，完成你的第一个学习伙伴。" />
        )}
      </section>

      <details ref={newCharacterRef} id="new-character" className="character-progressive-disclosure">
        <summary>
          <span>
            <span className="eyebrow">Create a Companion</span>
            <strong>创建新角色</strong>
          </span>
          <span className="muted">从性格、声音和形象开始</span>
        </summary>
        <div className="character-progressive-content">
          <CharacterWorkshop
            mode="create"
            seed={composerSeed}
            seedKey={composerVersion}
            adultRelationshipsEnabled={adultRelationshipsEnabled}
            busy={busy}
            notice={notice}
            error={error}
            title="新角色草稿"
            description="完成完整配方，保存后再进入详情页继续调整和导出角色包。"
            submitLabel="创建角色"
            statusLabel="Create Flow"
            onSubmit={handleCreate}
          />
        </div>
      </details>

      <details className="character-progressive-disclosure">
        <summary>
          <span>
            <span className="eyebrow">Bring Your Own Avatar</span>
            <strong>导入已有角色（高级）</strong>
          </span>
          <span className="muted">AIRI、VRM、CharacterPack 或 Character Card</span>
        </summary>
        <div className="character-progressive-content">
          <SectionCard
            title="导入角色文件"
            hint="接受 AIRI v0.11.3 角色包 .zip、单个 .vrm、CharacterPack .zip 或 Character Card V2/V3 .json；JSON 上限 1 MB，VRM/ZIP 上限 200 MiB。"
          >
            <div className="inline-actions">
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => packInputRef.current?.click()}
              >
                选择角色文件
              </button>
              <span className="muted">
                AIRI ZIP 会导入角色人格和声明的本地显示模型：VRM 通过格式与内嵌元数据校验后直接运行；Live2D/Spine ZIP 会经归档、引用和 SHA-256 校验后受保护保存，并只交给你配置的同源已许可运行时 bridge。未配置 bridge 时会明确阻止形象渲染，但不会冒充 VRM 或影响文字会话。任何格式校验都不证明你拥有使用或再分发授权；模型不会自动绑定学习空间。Character Card JSON 始终只导入人格，不执行提示词覆盖。
              </span>
            </div>
            <input
              ref={packInputRef}
              hidden
              type="file"
              accept=".vrm,.zip,.json,model/gltf-binary,application/zip,application/json"
              onChange={handleImport}
            />
            {importError ? <ErrorCallout message={importError} /> : null}
          </SectionCard>
        </div>
      </details>
    </section>
  );
}
