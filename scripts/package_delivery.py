#!/usr/bin/env python3
"""Build a deterministic, dependency-free Companion Space source delivery."""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import stat
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath


ARCHIVE_ROOT = "Companion-Space"
ALLOWED_DIRECTORIES = (
    "apps",
    "assets",
    "docs",
    "infra",
    "libs",
    "sample_data",
    "scripts",
    "services",
    "source",
    "tests",
)
ROOT_FILE_PATTERNS = (
    ".dockerignore",
    ".env.example",
    ".gitattributes",
    ".gitignore",
    "BACKUP-WINDOWS.ps1",
    "CONTRIBUTING.md",
    "docker-compose*.yml",
    "LICENSE",
    "NOTICE",
    "package-lock.json",
    "package.json",
    "playwright*.ts",
    "README.md",
    "README.en.md",
    "SET-DOCKER-MEMORY-WINDOWS.ps1",
    "START-*.ps1",
    "WINDOWS-README.md",
)
REQUIRED_ENTRYPOINTS = (
    "README.md",
    "LICENSE",
    "NOTICE",
    "package.json",
    "docker-compose.yml",
    "apps/web/package.json",
    "services/api/requirements.txt",
    "apps/web/public/assets/characters/models/manifest.json",
)
EXCLUDED_SEGMENTS = {
    ".agents",
    ".codex",
    ".git",
    ".gradle",
    ".kotlin",
    ".next",
    ".next-absolute-https",
    ".next-delivery",
    ".next-e2e",
    ".next-pre-https",
    ".omx",
    ".playwright",
    ".pytest_cache",
    ".ruff_cache",
    "__pycache__",
    "backups",
    "build",
    "coverage",
    "dist",
    "ios-release-output",
    "licensed-runtime",
    "node_modules",
    "playwright-report",
    "storage",
    "test-results",
}
EXCLUDED_FILE_NAMES = {
    "AI-HANDOFF.zh-CN.md".casefold(),
    "companion.db",
    "GoogleService-Info.plist".casefold(),
    "google-services.json",
    "local.properties",
}
SECRET_SUFFIXES = {
    ".cer",
    ".crt",
    ".db-shm",
    ".db-wal",
    ".ipa",
    ".jks",
    ".key",
    ".keystore",
    ".mobileprovision",
    ".p12",
    ".p8",
    ".pem",
    ".pfx",
}
REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


@dataclass(frozen=True)
class DeliveryResult:
    archive: Path
    manifest_file: Path
    sha256_file: Path
    sha256: str
    file_count: int
    source_bytes: int


def _is_link_or_reparse(entry: os.DirEntry[str] | Path) -> bool:
    if isinstance(entry, Path):
        info = entry.lstat()
        is_link = entry.is_symlink()
    else:
        info = entry.stat(follow_symlinks=False)
        is_link = entry.is_symlink()
    attributes = getattr(info, "st_file_attributes", 0)
    return is_link or bool(attributes & REPARSE_POINT)


def _is_excluded(relative: PurePosixPath, is_directory: bool) -> bool:
    folded_parts = tuple(part.casefold() for part in relative.parts)
    if folded_parts[:7] == ("apps", "web", "public", "assets", "characters", "art", "painted"):
        return True
    licensed_eciyuan_note = relative.as_posix().casefold() == "docs/design/eciyuan-adaptation.md"
    if not licensed_eciyuan_note and any("eciyuan" in part for part in folded_parts):
        return True
    if any(
        part in EXCLUDED_SEGMENTS or part.startswith(".next-") or part.startswith(".pw-") or part.endswith(".xcarchive")
        for part in folded_parts
    ):
        return True
    if folded_parts[:3] in {
        ("infra", "caddy", "data"),
        ("infra", "caddy", "config"),
    }:
        return True
    if folded_parts[:2] == ("docs", "handoff"):
        return True
    if is_directory:
        return False

    name = relative.name.casefold()
    if name in EXCLUDED_FILE_NAMES:
        return True
    if name == ".env" or (name.startswith(".env.") and name != ".env.example"):
        return True
    if name.endswith(".blend") or name.endswith(".blend1") or name == ".blender-built":
        return True
    if any(name.endswith(suffix) for suffix in SECRET_SUFFIXES):
        return True
    if relative.suffix.casefold() in {".db", ".sqlite", ".sqlite3", ".pyc", ".pyo", ".tsbuildinfo"}:
        return True
    if relative.parts[:2] == ("docs", "promo") and relative.suffix.casefold() == ".mp4":
        return True
    return False


def _root_file_allowed(name: str) -> bool:
    return any(fnmatch.fnmatchcase(name, pattern) for pattern in ROOT_FILE_PATTERNS)


def _walk_allowed_tree(root: Path, directory: Path, output_paths: set[Path]) -> list[Path]:
    collected: list[Path] = []
    try:
        entries = sorted(os.scandir(directory), key=lambda entry: entry.name.casefold())
    except OSError as error:
        raise RuntimeError(f"Cannot read source directory {directory}: {error}") from error

    for entry in entries:
        entry_path = Path(entry.path)
        relative = PurePosixPath(entry_path.relative_to(root).as_posix())
        if _is_link_or_reparse(entry):
            raise ValueError(f"Refusing link or reparse point in delivery source: {relative}")
        try:
            is_directory = entry.is_dir(follow_symlinks=False)
            is_file = entry.is_file(follow_symlinks=False)
        except OSError as error:
            raise RuntimeError(f"Cannot inspect source path {entry_path}: {error}") from error
        if _is_excluded(relative, is_directory):
            continue
        if is_directory:
            collected.extend(_walk_allowed_tree(root, entry_path, output_paths))
        elif is_file and entry_path.resolve() not in output_paths:
            collected.append(entry_path)
    return collected


def collect_delivery_files(root: Path, output_paths: set[Path]) -> list[Path]:
    root = root.resolve(strict=True)
    files: list[Path] = []
    for name in ALLOWED_DIRECTORIES:
        directory = root / name
        if not directory.exists():
            continue
        if _is_link_or_reparse(directory):
            raise ValueError(f"Refusing link or reparse point in delivery source: {name}")
        if not directory.is_dir():
            raise ValueError(f"Expected delivery source directory: {directory}")
        files.extend(_walk_allowed_tree(root, directory, output_paths))

    try:
        root_entries = sorted(os.scandir(root), key=lambda entry: entry.name.casefold())
    except OSError as error:
        raise RuntimeError(f"Cannot read repository root {root}: {error}") from error
    for entry in root_entries:
        if not _root_file_allowed(entry.name):
            continue
        if _is_link_or_reparse(entry):
            raise ValueError(f"Refusing link or reparse point in delivery source: {entry.name}")
        if entry.is_file(follow_symlinks=False) and Path(entry.path).resolve() not in output_paths:
            files.append(Path(entry.path))

    by_relative = {path.relative_to(root).as_posix(): path for path in files}
    missing = [entry for entry in REQUIRED_ENTRYPOINTS if entry not in by_relative]
    if missing:
        raise FileNotFoundError(f"Required delivery entrypoints are missing: {', '.join(missing)}")
    return [by_relative[name] for name in sorted(by_relative)]


def _read_bytes(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except OSError as error:
        raise RuntimeError(f"Cannot read required delivery file {path}: {error}") from error


def validate_vrm_manifest(root: Path) -> dict[str, object]:
    manifest_path = root / "apps/web/public/assets/characters/models/manifest.json"
    try:
        manifest = json.loads(_read_bytes(manifest_path))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"Invalid VRM manifest {manifest_path}: {error}") from error
    models = manifest.get("models")
    if not isinstance(models, list) or not models:
        raise ValueError("VRM manifest must contain a non-empty models array")
    model_root = manifest_path.parent.resolve()
    validated: list[dict[str, object]] = []
    seen: set[str] = set()
    for index, model in enumerate(models):
        if not isinstance(model, dict):
            raise ValueError(f"VRM manifest model {index} must be an object")
        filename = model.get("file")
        expected_hash = model.get("sha256")
        if not isinstance(filename, str) or not filename or PurePosixPath(filename).name != filename:
            raise ValueError(f"VRM manifest model {index} has an unsafe file path")
        if filename.casefold() in seen:
            raise ValueError(f"VRM manifest contains duplicate file {filename}")
        seen.add(filename.casefold())
        if not isinstance(expected_hash, str) or len(expected_hash) != 64:
            raise ValueError(f"VRM manifest model {filename} has an invalid SHA-256")
        model_path = model_root / filename
        if not model_path.is_file() or _is_link_or_reparse(model_path):
            raise FileNotFoundError(f"VRM manifest file is missing or unsafe: {filename}")
        payload = _read_bytes(model_path)
        actual_hash = hashlib.sha256(payload).hexdigest()
        if actual_hash != expected_hash.casefold():
            raise ValueError(
                f"VRM manifest SHA-256 mismatch for {filename}: expected {expected_hash}, got {actual_hash}"
            )
        expected_bytes = model.get("bytes")
        if expected_bytes is not None and expected_bytes != len(payload):
            raise ValueError(
                f"VRM manifest byte count mismatch for {filename}: expected {expected_bytes}, got {len(payload)}"
            )
        validated.append({"file": filename, "bytes": len(payload), "sha256": actual_hash})
    return {"manifest": manifest_path.relative_to(root).as_posix(), "models": validated}


def _zip_info(name: str, executable: bool) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    mode = 0o755 if executable else 0o644
    info.external_attr = (stat.S_IFREG | mode) << 16
    return info


def _json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _write_temporary_file(directory: Path, prefix: str, payload: bytes) -> Path:
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w+b", prefix=prefix, suffix=".tmp", dir=directory, delete=False
        ) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(payload)
            temporary.flush()
            os.fsync(temporary.fileno())
        return temporary_path
    except Exception:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
        raise


def _publish_artifacts(artifacts: list[tuple[Path, Path]]) -> None:
    published: list[Path] = []
    try:
        for temporary_path, target_path in artifacts:
            os.link(temporary_path, target_path)
            published.append(target_path)
    except Exception:
        for target_path in reversed(published):
            target_path.unlink(missing_ok=True)
        raise
    finally:
        for temporary_path, _target_path in artifacts:
            temporary_path.unlink(missing_ok=True)


def build_delivery(root: Path, output: Path) -> DeliveryResult:
    root = root.resolve(strict=True)
    output = output.resolve()
    manifest_file = output.with_suffix(output.suffix + ".manifest.json")
    sha256_file = output.with_suffix(output.suffix + ".sha256")
    targets = (output, manifest_file, sha256_file)
    existing = [path for path in targets if path.exists()]
    if existing:
        raise FileExistsError(f"Delivery artifact already exists; refusing to replace it: {existing[0]}")
    output.parent.mkdir(parents=True, exist_ok=True)

    output_paths = {path.resolve() for path in targets}
    source_files = collect_delivery_files(root, output_paths)
    vrm_evidence = validate_vrm_manifest(root)
    records: list[dict[str, object]] = []
    total_bytes = 0

    temporary_paths: list[Path] = []
    with tempfile.NamedTemporaryFile(
        mode="w+b", prefix=f".{output.name}.archive.", suffix=".tmp", dir=output.parent, delete=False
    ) as temporary:
        archive_temporary = Path(temporary.name)
        temporary_paths.append(archive_temporary)
    try:
        with zipfile.ZipFile(archive_temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for source in source_files:
                relative = source.relative_to(root).as_posix()
                payload = _read_bytes(source)
                digest = hashlib.sha256(payload).hexdigest()
                records.append({"path": relative, "bytes": len(payload), "sha256": digest})
                total_bytes += len(payload)
                executable = source.suffix.casefold() in {".sh", ".ps1"}
                archive.writestr(_zip_info(f"{ARCHIVE_ROOT}/{relative}", executable), payload)
            manifest = {
                "schema_version": 1,
                "archive_root": ARCHIVE_ROOT,
                "file_count": len(records),
                "source_bytes": total_bytes,
                "files": records,
                "vrm_validation": vrm_evidence,
            }
            manifest_payload = _json_bytes(manifest)
            archive.writestr(
                _zip_info(f"{ARCHIVE_ROOT}/DELIVERY-MANIFEST.json", False),
                manifest_payload,
            )

        archive_hash = hashlib.sha256(_read_bytes(archive_temporary)).hexdigest()
        manifest_temporary = _write_temporary_file(
            output.parent,
            f".{output.name}.manifest.",
            manifest_payload,
        )
        temporary_paths.append(manifest_temporary)
        sha256_temporary = _write_temporary_file(
            output.parent,
            f".{output.name}.sha256.",
            f"{archive_hash}  {output.name}\n".encode("utf-8"),
        )
        temporary_paths.append(sha256_temporary)
        # Publish the archive last so its presence is the commit marker for a complete trio.
        _publish_artifacts([
            (manifest_temporary, manifest_file),
            (sha256_temporary, sha256_file),
            (archive_temporary, output),
        ])
        temporary_paths.clear()
    finally:
        for temporary_path in temporary_paths:
            temporary_path.unlink(missing_ok=True)

    return DeliveryResult(
        archive=output,
        manifest_file=manifest_file,
        sha256_file=sha256_file,
        sha256=archive_hash,
        file_count=len(records),
        source_bytes=total_bytes,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve(strict=True)
    output = args.output or root / "outputs/Companion-Space-delivery.zip"
    result = build_delivery(root, output)
    print(f"archive={result.archive}")
    print(f"manifest={result.manifest_file}")
    print(f"sha256_file={result.sha256_file}")
    print(f"sha256={result.sha256}")
    print(f"files={result.file_count}")
    print(f"source_bytes={result.source_bytes}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
