from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path
from time import monotonic
from typing import Literal
from uuid import uuid4

from app.core.config import Settings


CheckpointMode = Literal["PASSIVE", "TRUNCATE"]


class SQLiteMaintenanceError(RuntimeError):
    pass


@dataclass(frozen=True)
class CheckpointResult:
    mode: CheckpointMode
    busy: int
    wal_pages: int
    checkpointed_pages: int


class CheckpointBusyError(SQLiteMaintenanceError):
    def __init__(self, result: CheckpointResult) -> None:
        self.result = result
        super().__init__(
            f"SQLite {result.mode} checkpoint remained busy "
            f"({result.checkpointed_pages}/{result.wal_pages} pages checkpointed)"
        )


@dataclass(frozen=True)
class BackupResult:
    destination: Path
    size_bytes: int
    sha256: str
    user_version: int
    integrity_check: str
    foreign_key_violation_count: int


def _is_link_or_junction(path: Path) -> bool:
    if path.is_symlink():
        return True
    is_junction = getattr(path, "is_junction", None)
    return bool(is_junction and is_junction())


def _reject_link_ancestors(path: Path) -> None:
    candidate = path if path.is_absolute() else Path.cwd() / path
    for item in (candidate, *candidate.parents):
        if _is_link_or_junction(item):
            raise SQLiteMaintenanceError(
                f"SQLite maintenance path cannot use a symlink or junction: {item}"
            )


def _source_database(path: Path) -> Path:
    if ".." in path.parts:
        raise SQLiteMaintenanceError("SQLite source path cannot contain '..'")
    _reject_link_ancestors(path)
    try:
        resolved = path.resolve(strict=True)
    except FileNotFoundError as exc:
        raise SQLiteMaintenanceError(f"SQLite database does not exist: {path}") from exc
    if not resolved.is_file():
        raise SQLiteMaintenanceError(f"SQLite database is not a file: {resolved}")
    return resolved


def _destination_database(source: Path, destination: Path) -> Path:
    if ".." in destination.parts:
        raise SQLiteMaintenanceError("SQLite backup destination cannot contain '..'")
    _reject_link_ancestors(destination)
    if destination.exists():
        raise FileExistsError(f"SQLite backup destination already exists: {destination}")
    parent = destination.parent.resolve(strict=True)
    if not parent.is_dir():
        raise SQLiteMaintenanceError(
            f"SQLite backup destination parent is not a directory: {parent}"
        )
    resolved = (parent / destination.name).resolve(strict=False)
    if resolved == source or resolved.is_relative_to(source.parent):
        raise SQLiteMaintenanceError(
            "SQLite backup destination must be outside the source storage directory"
        )
    return resolved


def _connect(
    path: Path,
    *,
    busy_timeout_ms: int,
    readonly: bool,
) -> sqlite3.Connection:
    if busy_timeout_ms < 0:
        raise ValueError("busy_timeout_ms must be non-negative")
    target: str
    if readonly:
        target = f"{path.as_uri()}?mode=ro"
    else:
        target = str(path)
    conn = sqlite3.connect(
        target,
        timeout=busy_timeout_ms / 1_000,
        uri=readonly,
        autocommit=True,
    )
    try:
        conn.execute(f"PRAGMA busy_timeout = {busy_timeout_ms}")
        return conn
    except BaseException:
        conn.close()
        raise


def checkpoint_database(
    db_path: Path,
    *,
    mode: CheckpointMode,
    busy_timeout_ms: int,
) -> CheckpointResult:
    if mode not in ("PASSIVE", "TRUNCATE"):
        raise ValueError(f"Unsupported SQLite checkpoint mode: {mode}")
    source = _source_database(Path(db_path))
    conn = _connect(source, busy_timeout_ms=busy_timeout_ms, readonly=False)
    try:
        row = conn.execute(f"PRAGMA wal_checkpoint({mode})").fetchone()
    finally:
        conn.close()
    result = CheckpointResult(
        mode=mode,
        busy=int(row[0]),
        wal_pages=int(row[1]),
        checkpointed_pages=int(row[2]),
    )
    if result.busy:
        raise CheckpointBusyError(result)
    return result


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def backup_database(
    db_path: Path,
    destination: Path,
    *,
    busy_timeout_ms: int,
    busy_deadline_seconds: float = 30.0,
) -> BackupResult:
    if busy_deadline_seconds <= 0:
        raise ValueError("busy_deadline_seconds must be positive")
    source = _source_database(Path(db_path))
    target = _destination_database(source, Path(destination))
    partial = target.with_name(f"{target.name}.partial-{uuid4().hex}")
    descriptor = os.open(partial, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)

    source_conn = _connect(source, busy_timeout_ms=busy_timeout_ms, readonly=True)
    deadline = monotonic() + busy_deadline_seconds

    def stop_after_deadline(status: int, _remaining: int, _total: int) -> None:
        if status != sqlite3.SQLITE_DONE and monotonic() >= deadline:
            raise TimeoutError("SQLite online backup exceeded its busy deadline")

    try:
        target_conn = _connect(partial, busy_timeout_ms=busy_timeout_ms, readonly=False)
        try:
            source_conn.backup(
                target_conn,
                pages=256,
                progress=stop_after_deadline,
                sleep=0.05,
            )
            journal_mode = target_conn.execute(
                "PRAGMA journal_mode = DELETE"
            ).fetchone()[0]
            if str(journal_mode).lower() != "delete":
                raise SQLiteMaintenanceError(
                    f"SQLite backup journal mode remained {journal_mode!r}"
                )
            integrity_rows = [
                str(row[0])
                for row in target_conn.execute("PRAGMA integrity_check").fetchall()
            ]
            if integrity_rows != ["ok"]:
                raise SQLiteMaintenanceError("SQLite backup failed integrity_check")
            foreign_key_violations = target_conn.execute(
                "PRAGMA foreign_key_check"
            ).fetchall()
            if foreign_key_violations:
                raise SQLiteMaintenanceError(
                    "SQLite backup contains foreign key violations"
                )
            user_version = int(
                target_conn.execute("PRAGMA user_version").fetchone()[0]
            )
        finally:
            target_conn.close()
    finally:
        source_conn.close()

    size_bytes = partial.stat().st_size
    sha256 = _sha256(partial)
    os.link(partial, target)
    partial.unlink()
    return BackupResult(
        destination=target.resolve(strict=True),
        size_bytes=size_bytes,
        sha256=sha256,
        user_version=user_version,
        integrity_check="ok",
        foreign_key_violation_count=0,
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Maintain Companion Space SQLite data")
    commands = parser.add_subparsers(dest="command", required=True)
    checkpoint = commands.add_parser("checkpoint")
    checkpoint.add_argument("--mode", choices=("PASSIVE", "TRUNCATE"), default="TRUNCATE")
    backup = commands.add_parser("backup")
    backup.add_argument("--destination-directory", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    settings = Settings()
    try:
        if args.command == "checkpoint":
            result = checkpoint_database(
                settings.metadata_db_path,
                mode=args.mode,
                busy_timeout_ms=settings.sqlite_busy_timeout_ms,
            )
            payload = {
                "mode": result.mode,
                "busy": result.busy,
                "wal_pages": result.wal_pages,
                "checkpointed_pages": result.checkpointed_pages,
            }
        else:
            result = backup_database(
                settings.metadata_db_path,
                args.destination_directory / settings.sqlite_db_filename,
                busy_timeout_ms=settings.sqlite_busy_timeout_ms,
            )
            payload = {
                "destination": str(result.destination),
                "database_filename": result.destination.name,
                "size_bytes": result.size_bytes,
                "sha256": result.sha256,
                "user_version": result.user_version,
                "integrity_check": result.integrity_check,
                "foreign_key_violation_count": result.foreign_key_violation_count,
            }
    except (OSError, sqlite3.Error, SQLiteMaintenanceError, TimeoutError, ValueError) as exc:
        print(f"SQLite maintenance failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
