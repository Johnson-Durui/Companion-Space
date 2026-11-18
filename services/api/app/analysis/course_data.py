from __future__ import annotations

import json
import re
import shutil
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from app.analysis.models import Course, CourseInput, CourseMaterial, MaterialMetadata
from app.core.errors import ResourceNotFoundError
from app.models.domain import MaterialKind, StudySpace
from app.repositories.mixins.common import _to_db, utcnow
from app.services.material_storage import build_material_storage_key
from app.services.repository import SQLiteRepository

_KIND = {".pdf": "pdf", ".docx": "docx", ".pptx": "pptx", ".md": "markdown", ".txt": "text"}
_YEAR = re.compile(r"(?<!\d)(?:19|20)\d{2}(?!\d)")


def dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def suggest_role(filename: str, sample: str) -> str:
    title = Path(filename).stem.lower()
    if re.search(r"exam|past.paper|\u771f\u9898|\u8bd5\u5377|\u6a21\u8003|\u8003\u9898", title + " " + sample[:300].lower()):
        return "exam"
    if re.search(r"syllabus|\u8003\u7eb2|\u6559\u5b66\u5927\u7eb2", title):
        return "syllabus"
    if re.search(r"exercise|homework|\u4e60\u9898|\u4f5c\u4e1a|\u7ec3\u4e60", title):
        return "exercise"
    if re.search(r"notes?|\u7b14\u8bb0", title):
        return "notes"
    if Path(filename).suffix.lower() == ".pptx" or re.search(r"slides?|\u8bfe\u4ef6", title):
        return "slides"
    return "textbook"


class CourseData:
    def __init__(self, repository: SQLiteRepository) -> None:
        self.repository = repository
        self.root = repository.settings.storage_root

    def courses(self) -> list[Course]:
        with self.repository.connection() as conn:
            rows = conn.execute(
                "SELECT id, name, goal, brief_json FROM study_spaces ORDER BY updated_at DESC, id",
            ).fetchall()
        return [self._course(row) for row in rows]

    def create_course(self, payload: CourseInput) -> Course:
        now = utcnow()
        space = StudySpace(
            id=str(uuid4()), name=payload.name, goal=payload.goal, created_at=now, updated_at=now,
        )
        self.repository.upsert_space(space)
        return Course(id=space.id, name=space.name, goal=space.goal)

    def course(self, space_id: str) -> Course:
        with self.repository.connection() as conn:
            row = conn.execute(
                "SELECT id, name, goal, brief_json FROM study_spaces WHERE id = ?", (space_id,),
            ).fetchone()
        if row is None:
            raise ResourceNotFoundError("Course not found")
        return self._course(row)

    def update_course(self, space_id: str, payload: CourseInput) -> Course:
        existing = self.repository.get_space(space_id)
        if existing is None:
            raise ResourceNotFoundError("Course not found")
        self.repository.update_space_metadata(
            space_id=space_id, name=payload.name, topic=existing.topic, goal=payload.goal, updated_at=utcnow(),
        )
        return self.course(space_id)

    def delete_course(self, space_id: str) -> bool:
        self.course(space_id)
        for material in self.material_rows(space_id):
            self.original(material)
        paths = [self.safe_path(f"{folder}/{space_id}") for folder in ("spaces", "courses")]
        with self._stage_deletion(paths):
            if not self.repository.delete_space(space_id):
                raise ResourceNotFoundError("Course not found")
        return True

    def delete_material(self, space_id: str, material_id: str) -> bool:
        material = next((row for row in self.material_rows(space_id) if row["id"] == material_id), None)
        if material is None:
            raise ResourceNotFoundError("Material not found")
        paths = [self.original(material), self.images_dir(space_id, material_id)]
        with self._stage_deletion(paths):
            with self.repository.connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                changed = conn.execute(
                    "DELETE FROM materials WHERE id = ? AND space_id = ?", (material_id, space_id),
                )
                if changed.rowcount != 1:
                    raise ResourceNotFoundError("Material not found")
                conn.execute("DELETE FROM item_bank WHERE space_id = ?", (space_id,))
                conn.execute("DELETE FROM kp_exam_stats WHERE space_id = ?", (space_id,))
                conn.execute("UPDATE study_spaces SET brief_json = NULL WHERE id = ?", (space_id,))
                for point in conn.execute(
                    "SELECT id, source_refs_json FROM knowledge_points WHERE space_id = ?", (space_id,),
                ).fetchall():
                    refs = json.loads(point["source_refs_json"] or "[]")
                    kept = [ref for ref in refs if ref["material_id"] != material_id]
                    if len(kept) != len(refs):
                        conn.execute(
                            """UPDATE knowledge_points SET source_refs_json = ?,
                               status = CASE WHEN status = 'active' AND ? = 0 THEN 'archived' ELSE status END
                               WHERE space_id = ? AND id = ?""",
                            (dumps(kept), len(kept), space_id, point["id"]),
                        )
        return True

    @contextmanager
    def _stage_deletion(self, paths: list[Path]):
        staged = []
        try:
            for path in paths:
                if path.exists():
                    target = path.with_name(f".d-{uuid4().hex}{path.suffix}")
                    path.rename(target)
                    staged.append((path, target))
            yield
        except BaseException:
            for original, target in reversed(staged):
                target.rename(original)
            raise
        for _, target in staged:
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()

    @staticmethod
    def _course(row) -> Course:
        return Course(id=row["id"], name=row["name"], goal=row["goal"], brief=json.loads(row["brief_json"] or "null"))

    def materials(self, space_id: str) -> list[CourseMaterial]:
        self.course(space_id)
        return [self._material(row) for row in self.material_rows(space_id)]

    def material_rows(self, space_id: str) -> list[dict]:
        with self.repository.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM materials WHERE space_id = ? ORDER BY created_at, id", (space_id,),
            ).fetchall()
        records = []
        for row in rows:
            record = dict(row)
            record.update(json.loads(record.pop("meta_json") or "{}"))
            records.append(record)
        return records

    @staticmethod
    def _material(row: dict) -> CourseMaterial:
        return CourseMaterial.model_validate(row)

    def store_uploads(
        self, space_id: str, uploads: list[tuple[str, bytes, MaterialMetadata, str, int]],
        *, note_title: str | None = None,
    ) -> list[CourseMaterial]:
        self.course(space_id)
        records = []
        files = []
        now = _to_db(utcnow())
        try:
            with self.repository.connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                for filename, data, metadata, sample, estimated_pages in uploads:
                    material_id = str(uuid4())
                    key = build_material_storage_key(space_id=space_id, material_id=material_id, filename=filename)
                    path = self.safe_path(key)
                    path.parent.mkdir(parents=True, exist_ok=True)
                    role = metadata.role or suggest_role(filename, sample)
                    exam_year = _YEAR.search(filename)
                    meta = metadata.model_dump(exclude_none=True, exclude={"role"})
                    if role == "exam" and "year" not in meta and exam_year:
                        meta["year"] = int(exam_year.group())
                    meta["estimated_pages"] = estimated_pages
                    title = note_title or Path(filename).stem[:120]
                    kind = MaterialKind.note.value if note_title else _KIND.get(path.suffix, "image")
                    with path.open("xb") as stream:
                        files.append(path)
                        stream.write(data)
                    conn.execute(
                        """INSERT INTO materials(id, space_id, title, kind, filename, storage_path,
                            created_at, updated_at, role, meta_json)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (material_id, space_id, title, kind, filename, key, now, now, role, dumps(meta)),
                    )
                    records.append(CourseMaterial(
                        id=material_id, filename=filename, title=title, role=role, parse_status="pending", **meta,
                    ))
                conn.execute("UPDATE study_spaces SET updated_at = ? WHERE id = ?", (now, space_id))
        except BaseException:
            for path in files:
                path.unlink(missing_ok=True)
            raise
        return records

    def update_material(self, space_id: str, material_id: str, payload: MaterialMetadata) -> CourseMaterial:
        with self.repository.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM materials WHERE space_id = ? AND id = ?", (space_id, material_id),
            ).fetchone()
            if row is None:
                raise ResourceNotFoundError("Material not found")
            meta = json.loads(row["meta_json"] or "{}")
            meta.update(payload.model_dump(exclude_unset=True, exclude={"role"}))
            role = payload.role or row["role"]
            conn.execute(
                "UPDATE materials SET role = ?, meta_json = ?, updated_at = ? WHERE space_id = ? AND id = ?",
                (role, dumps(meta), _to_db(utcnow()), space_id, material_id),
            )
        return self._material({**dict(row), **meta, "role": role})

    def safe_path(self, key: str) -> Path:
        relative = Path(key)
        if relative.drive or relative.anchor or ".." in relative.parts:
            raise ValueError("Material storage path is invalid")
        path = self.root
        for part in relative.parts:
            path /= part
            if path.is_symlink() or path.is_junction():
                raise ValueError("Material storage path contains a link")
        if not path.resolve().is_relative_to(self.root):
            raise ValueError("Material storage path is invalid")
        return path

    def original(self, material: dict) -> Path:
        expected = build_material_storage_key(
            space_id=material["space_id"], material_id=material["id"], filename=material["filename"],
        )
        if material["storage_path"] != expected:
            raise ValueError("Material storage path is invalid")
        return self.safe_path(expected)

    def images_dir(self, space_id: str, material_id: str) -> Path:
        return self.safe_path(f"courses/{space_id}/pages/{material_id}")

    def get_page(self, material_id: str, number: int) -> dict:
        with self.repository.connection() as conn:
            row = conn.execute(
                """SELECT p.* FROM material_pages p JOIN materials m
                   ON p.material_id = m.id AND p.space_id = m.space_id
                   WHERE m.id = ? AND p.page_no = ?""",
                (material_id, number),
            ).fetchone()
        if row is None:
            raise ResourceNotFoundError("Page not found")
        return dict(row)

    def pages(self, space_id: str, material_id: str) -> list[dict]:
        with self.repository.connection() as conn:
            rows = conn.execute(
                """SELECT page_no, markdown, source, quality, image_path FROM material_pages
                   WHERE space_id = ? AND material_id = ? ORDER BY page_no""",
                (space_id, material_id),
            ).fetchall()
        return [dict(row) for row in rows]

    def sections(self, space_id: str, material_id: str) -> list[dict]:
        with self.repository.connection() as conn:
            rows = conn.execute(
                """SELECT id, parent_id, level, title, page_start, page_end, ord
                   FROM material_sections WHERE space_id = ? AND material_id = ? ORDER BY ord""",
                (space_id, material_id),
            ).fetchall()
        return [dict(row) for row in rows]

    def set_parse_state(self, material: dict, status: str, **changes) -> None:
        with self.repository.connection() as conn:
            self._save_parse_state(conn, material, status, changes)

    @staticmethod
    def _save_parse_state(conn, material: dict, status: str, changes: dict) -> None:
        row = conn.execute(
            "SELECT meta_json FROM materials WHERE id = ? AND space_id = ?",
            (material["id"], material["space_id"]),
        ).fetchone()
        if row is None:
            raise ResourceNotFoundError("Material not found")
        meta = json.loads(row["meta_json"] or "{}")
        meta.update(changes)
        conn.execute(
            "UPDATE materials SET parse_status = ?, meta_json = ? WHERE id = ? AND space_id = ?",
            (status, dumps(meta), material["id"], material["space_id"]),
        )

    def save_pages(self, material: dict, pages: list[dict], bookmarks: list, *, error: str | None = None) -> None:
        material_id, space_id = material["id"], material["space_id"]
        scanned = sum(page["quality"] == 0 for page in pages)
        with self.repository.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM material_pages WHERE space_id = ? AND material_id = ?", (space_id, material_id))
            conn.executemany(
                """INSERT INTO material_pages(material_id, space_id, page_no, markdown, source, quality, image_path)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                [(material_id, space_id, page["page_no"], page["markdown"], page["source"], page["quality"],
                  page["image_path"]) for page in pages],
            )
            self._save_parse_state(conn, material, "needs_vision" if scanned else "parsed", {
                "page_count": len(pages), "scanned_pages": scanned, "bookmarks": bookmarks, "error": error,
                "indexed": False,
            })

    def save_sections(self, material: dict, sections: list[dict]) -> None:
        material_id, space_id = material["id"], material["space_id"]
        with self.repository.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM material_sections WHERE space_id = ? AND material_id = ?", (space_id, material_id))
            conn.executemany(
                """INSERT INTO material_sections(id, material_id, space_id, parent_id, level, title,
                    page_start, page_end, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                [(s["id"], material_id, space_id, s["parent_id"], s["level"], s["title"],
                  s["page_start"], s["page_end"], s["ord"]) for s in sections],
            )

    def save_chunks(
        self, material: dict, chunks: list[dict], embeddings: list[bytes | None], model: str | None,
    ) -> None:
        material_id, space_id = material["id"], material["space_id"]
        now = _to_db(utcnow())
        with self.repository.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM chunks WHERE space_id = ? AND material_id = ?", (space_id, material_id))
            conn.executemany(
                """INSERT INTO chunks(id, space_id, material_id, title, locator, content, sparse_terms, dense_vector,
                   metadata_json, created_at, section_id, page_no, embedding, embedding_model)
                   VALUES (?, ?, ?, ?, ?, ?, '[]', '{}', '{}', ?, ?, ?, ?, ?)""",
                [(str(uuid4()), space_id, material_id, material["title"], str(c["page_no"]), c["content"],
                  now, c["section_id"], c["page_no"], vector, model)
                 for c, vector in zip(chunks, embeddings, strict=True)],
            )
            conn.execute(
                "UPDATE materials SET chunk_count = ? WHERE id = ? AND space_id = ?", (len(chunks), material_id, space_id),
            )
            row = conn.execute(
                "SELECT parse_status FROM materials WHERE id = ? AND space_id = ?", (material_id, space_id),
            ).fetchone()
            self._save_parse_state(conn, material, row["parse_status"], {"indexed": True, "embedding_model": model})
