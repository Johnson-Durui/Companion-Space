import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { requireCleanRepository, requirePathOutsideRepository } from "./release-common.mjs";

function git(repository, ...args) {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stderr || result.stdout}`);
}

async function createCommittedRepository(base) {
  const repository = resolve(base, "repository");
  await mkdir(repository);
  git(repository, "init");
  git(repository, "config", "user.email", "release-gate@example.invalid");
  git(repository, "config", "user.name", "Release Gate Test");
  await writeFile(resolve(repository, "tracked.txt"), "committed\n", "utf8");
  git(repository, "add", "tracked.txt");
  git(repository, "commit", "-m", "test fixture");
  return repository;
}

test("clean repository gate rejects every dirty state", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "companion-release-git-"));
  try {
    const repository = await createCommittedRepository(base);
    assert.equal(requireCleanRepository(repository).sourceTreeClean, true);

    await context.test("untracked file", async () => {
      await writeFile(resolve(repository, "untracked.txt"), "untracked\n", "utf8");
      assert.throws(() => requireCleanRepository(repository), /no untracked files/);
      await rm(resolve(repository, "untracked.txt"));
    });

    await context.test("modified tracked file", async () => {
      await writeFile(resolve(repository, "tracked.txt"), "modified\n", "utf8");
      assert.throws(() => requireCleanRepository(repository), /clean committed repository/);
      git(repository, "restore", "tracked.txt");
    });

    await context.test("staged change", async () => {
      await writeFile(resolve(repository, "tracked.txt"), "staged\n", "utf8");
      git(repository, "add", "tracked.txt");
      assert.throws(() => requireCleanRepository(repository), /clean committed repository/);
      git(repository, "restore", "--staged", "tracked.txt");
      git(repository, "restore", "tracked.txt");
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("repository path gate rejects lexical and linked paths into the repository", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "companion-release-path-"));
  try {
    const repository = resolve(base, "repository");
    const external = resolve(base, "external");
    await mkdir(repository);
    await mkdir(external);
    await writeFile(resolve(repository, "secret.p8"), "fixture\n", "utf8");

    assert.throws(
      () => requirePathOutsideRepository(resolve(repository, "secret.p8"), repository, "key"),
      /outside the repository/,
    );
    assert.throws(
      () => requirePathOutsideRepository(resolve(repository, "missing/output"), repository, "output"),
      /outside the repository/,
    );
    assert.equal(requirePathOutsideRepository(resolve(external, "release"), repository, "output"), resolve(external, "release"));

    await context.test("external link resolving into repository", async (linkedContext) => {
      const link = resolve(external, "repository-link");
      try {
        await symlink(repository, link, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        linkedContext.skip(`filesystem link unavailable: ${error.code ?? error.message}`);
        return;
      }
      assert.throws(
        () => requirePathOutsideRepository(resolve(link, "secret.p8"), repository, "key"),
        /outside the repository/,
      );
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
