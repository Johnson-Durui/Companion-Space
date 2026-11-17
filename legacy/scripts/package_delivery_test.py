import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from scripts import package_delivery


class DeliveryPackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="companion-package-")
        self.root = Path(self.temp.name).resolve(strict=True)
        self._write("README.md", "demo\n")
        self._write("LICENSE", "license\n")
        self._write("NOTICE", "notice\n")
        self._write("package.json", "{}\n")
        self._write("docker-compose.yml", "services: {}\n")
        self._write("apps/web/package.json", "{}\n")
        self._write("services/api/requirements.txt", "fastapi\n")
        model = b"original-vrm-fixture"
        self._write_bytes("apps/web/public/assets/characters/models/Nova.vrm", model)
        self._write(
            "apps/web/public/assets/characters/models/manifest.json",
            json.dumps({
                "models": [{
                    "file": "Nova.vrm",
                    "sha256": hashlib.sha256(model).hexdigest(),
                    "bytes": len(model),
                }],
            }),
        )

    def tearDown(self):
        self.temp.cleanup()

    def _write(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def _write_bytes(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    def test_packages_untracked_original_sources_but_excludes_secrets_and_output(self):
        self._write("apps/web/components/new-original.tsx", "export const original = true;\n")
        self._write("README.en.md", "English guide\n")
        self._write_bytes("apps/web/public/assets/characters/art/painted/Nova_face.png", b"source-texture")
        self._write_bytes("apps/web/public/assets/characters/art/roster/nova.png", b"roster-card")
        self._write(".env", "SECRET=do-not-ship\n")
        self._write("storage/companion.db", "private\n")
        self._write("assets/private.key", "private\n")
        self._write("apps/web/private.sqlite", "private\n")
        self._write("assets/Eciyuan/third-party.txt", "unlicensed\n")
        self._write("docs/design/eciyuan-adaptation.md", "clean-room interaction notes\n")
        output = self.root / "outputs" / "candidate.zip"

        result = package_delivery.build_delivery(self.root, output)

        with zipfile.ZipFile(output) as archive:
            names = set(archive.namelist())
        self.assertIn("Companion-Space/apps/web/components/new-original.tsx", names)
        self.assertIn("Companion-Space/apps/web/public/assets/characters/models/Nova.vrm", names)
        self.assertIn("Companion-Space/apps/web/public/assets/characters/art/roster/nova.png", names)
        self.assertNotIn("Companion-Space/apps/web/public/assets/characters/art/painted/Nova_face.png", names)
        self.assertIn("Companion-Space/DELIVERY-MANIFEST.json", names)
        self.assertIn("Companion-Space/README.en.md", names)
        self.assertIn("Companion-Space/docs/design/eciyuan-adaptation.md", names)
        self.assertFalse(any(".env" in name or "storage/" in name for name in names))
        forbidden_eciyuan = [
            name for name in names
            if "eciyuan" in name.lower()
            and name != "Companion-Space/docs/design/eciyuan-adaptation.md"
        ]
        self.assertFalse(any(name.endswith(".key") for name in names))
        self.assertEqual(forbidden_eciyuan, [])
        self.assertFalse(any(name.endswith(".sqlite") for name in names))
        self.assertNotIn("Companion-Space/outputs/candidate.zip", names)
        self.assertEqual(result.archive, output)
        self.assertTrue(result.sha256_file.is_file())
        self.assertTrue(result.manifest_file.is_file())

    def test_excludes_incremental_and_native_build_caches(self):
        generated = (
            "apps/web/tsconfig.tsbuildinfo",
            "services/api/app/module.pyc",
            "apps/mobile/android/.kotlin/session/cache.bin",
            "apps/mobile/ios/diagnostic.xcarchive/Info.plist",
        )
        for relative in generated:
            self._write(relative, "generated cache\n")

        collected = {
            path.relative_to(self.root).as_posix()
            for path in package_delivery.collect_delivery_files(self.root, set())
        }

        self.assertFalse(set(generated) & collected)
        self.assertIn("apps/web/package.json", collected)

    def test_excludes_workspace_playwright_and_next_caches(self):
        generated = (
            ".pw-full/results.json",
            ".pw-focus/screenshot.png",
            ".pw-vr/trace.zip",
            "apps/web/.next-delivery-final/BUILD_ID",
            "apps/web/.next-custom-cache/BUILD_ID",
        )
        for relative in generated:
            self._write(relative, "generated cache\n")

        collected = {
            path.relative_to(self.root).as_posix()
            for path in package_delivery.collect_delivery_files(self.root, set())
        }

        self.assertFalse(set(generated) & collected)

    def test_refuses_to_replace_any_existing_artifact(self):
        output = self.root / "candidate.zip"
        output.write_bytes(b"keep-me")

        with self.assertRaisesRegex(FileExistsError, "already exists"):
            package_delivery.build_delivery(self.root, output)

        self.assertEqual(output.read_bytes(), b"keep-me")

    def test_vrm_manifest_mismatch_is_fatal(self):
        self._write_bytes("apps/web/public/assets/characters/models/Nova.vrm", b"tampered")

        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            package_delivery.build_delivery(self.root, self.root / "candidate.zip")

    def test_same_sources_produce_identical_archives(self):
        first = package_delivery.build_delivery(self.root, self.root / "first.zip")
        second = package_delivery.build_delivery(self.root, self.root / "second.zip")

        self.assertEqual(first.sha256, second.sha256)
        self.assertEqual(first.archive.read_bytes(), second.archive.read_bytes())

    def test_unreadable_required_file_fails_loudly(self):
        target = self.root / "apps/web/package.json"
        original = Path.read_bytes

        def deny_one(path):
            if path == target:
                raise PermissionError("fixture denied")
            return original(path)

        with mock.patch.object(Path, "read_bytes", deny_one):
            with self.assertRaisesRegex(RuntimeError, "Cannot read required delivery file"):
                package_delivery.build_delivery(self.root, self.root / "candidate.zip")

    def test_sidecar_write_failure_publishes_nothing_and_can_retry(self):
        output = self.root / "candidate.zip"
        manifest = Path(f"{output}.manifest.json")
        sha256 = Path(f"{output}.sha256")
        original = package_delivery._write_temporary_file

        def fail_manifest(directory, prefix, payload):
            if ".manifest." in prefix:
                raise OSError("fixture sidecar failure")
            return original(directory, prefix, payload)

        with mock.patch.object(package_delivery, "_write_temporary_file", fail_manifest):
            with self.assertRaisesRegex(OSError, "fixture sidecar failure"):
                package_delivery.build_delivery(self.root, output)

        self.assertFalse(output.exists())
        self.assertFalse(manifest.exists())
        self.assertFalse(sha256.exists())
        retry = package_delivery.build_delivery(self.root, output)
        self.assertTrue(retry.archive.is_file())
        self.assertTrue(retry.manifest_file.is_file())
        self.assertTrue(retry.sha256_file.is_file())

    def test_publish_failure_rolls_back_only_artifacts_from_this_attempt(self):
        output = self.root / "candidate.zip"
        targets = [output, Path(f"{output}.manifest.json"), Path(f"{output}.sha256")]
        unrelated = self.root / "keep.txt"
        unrelated.write_text("keep-me", encoding="utf-8")
        original = package_delivery.os.link
        calls = 0

        def fail_second_link(source, target):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("fixture publish failure")
            return original(source, target)

        with mock.patch.object(package_delivery.os, "link", fail_second_link):
            with self.assertRaisesRegex(OSError, "fixture publish failure"):
                package_delivery.build_delivery(self.root, output)

        self.assertTrue(all(not target.exists() for target in targets))
        self.assertEqual(unrelated.read_text(encoding="utf-8"), "keep-me")
        self.assertEqual(list(self.root.glob(".candidate.zip.*.tmp")), [])
        retry = package_delivery.build_delivery(self.root, output)
        self.assertTrue(retry.archive.is_file())

    def test_rejects_links_in_an_allowed_source_tree(self):
        self._write("docs/linked.txt", "fixture\n")
        original = package_delivery._is_link_or_reparse

        def mark_fixture_as_reparse(entry):
            if getattr(entry, "name", None) == "linked.txt":
                return True
            return original(entry)

        with mock.patch.object(package_delivery, "_is_link_or_reparse", mark_fixture_as_reparse):
            with self.assertRaisesRegex(ValueError, "link or reparse"):
                package_delivery.build_delivery(self.root, self.root / "candidate.zip")


if __name__ == "__main__":
    unittest.main()
