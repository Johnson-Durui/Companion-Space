"""Check the mechanically verifiable constraints from AGENTS.md."""

import ast
import json
import re
import subprocess
from pathlib import Path, PurePosixPath

BANNED = re.compile(r"\b(?:mock|fake|demo_mode|canned)\b", re.IGNORECASE)
PLACEHOLDER = re.compile(r"\{\{\s*\??\s*([A-Za-z_][A-Za-z_0-9]*)\s*\}\}")
HAN_PATTERN = (
    "[\u3007\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"
    "\U00020000-\U0002ee5f\U0002f800-\U0002fa1f\U00030000-\U000323af]"
)
HAN = re.compile(HAN_PATTERN)
TS_EXTENSIONS = {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"}
PYTHON_FEATURES = {"teaching", "learning", "analysis", "voice"}
WEB_FEATURES = {"classroom", "learner", "plan", "review"}
PROMPTS = Path("libs/prompts/v3")
LOCALES = (
    "services/api/app/i18n/zh-CN.json",
    "apps/web/src/locales/zh-CN.json",
    "content/speech/zh-CN.json",
)

# Reuse the installed TypeScript parser to distinguish literal text from comments
# and code embedded in template strings.
TS_LITERAL_CHECK = r"""
const fs = require("node:fs");
const ts = require("typescript");
const { paths, han } = JSON.parse(fs.readFileSync(0, "utf8"));
const hanPattern = new RegExp(han, "gu");
const violations = [];
for (const path of paths) {
    const source = ts.createSourceFile(path, fs.readFileSync(path, "utf8"), ts.ScriptTarget.Latest);
    const lines = new Set();
    function visit(node) {
        let literal;
        if (ts.isTemplateExpression(node)) {
            literal = node.head.text + node.templateSpans.map(span => span.literal.text).join("");
        } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) {
            literal = node.text;
        }
        if ((literal?.match(hanPattern)?.length ?? 0) >= 4) {
            lines.add(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
        }
        ts.forEachChild(node, visit);
    }
    visit(source);
    for (const line of lines) violations.push([path, line]);
}
process.stdout.write(JSON.stringify(violations));
"""


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")


def load_allowlist(path: Path) -> set[str]:
    allowed = set()
    if path.is_file():
        for number, raw_line in enumerate(read_text(path).splitlines(), 1):
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split(maxsplit=1)
            relative = PurePosixPath(parts[0].replace("\\", "/"))
            if len(parts) != 2 or relative.is_absolute() or ":" in parts[0] or ".." in relative.parts:
                raise ValueError(f"scripts/no_fakes_allowlist.txt:{number}: expected a relative path and reason")
            allowed.add(relative.as_posix())
    return allowed


def product_texts(root: Path):
    roots = [
        root / "services/api/app",
        root / "apps/web/src",
        root / PROMPTS,
        *sorted((root / "packages").glob("*/src")),
    ]
    for directory in roots:
        for file in sorted(directory.rglob("*")):
            relative = file.relative_to(root)
            if not file.is_file() or "__tests__" in relative.parts or ".test." in file.name:
                continue
            try:
                yield relative, read_text(file)
            except UnicodeDecodeError:
                # Product source roots can also contain binary assets.
                if file.suffix in TS_EXTENSIONS | {".py", ".md", ".txt", ".json", ".css", ".html"}:
                    raise ValueError(f"{relative.as_posix()}: expected UTF-8 text") from None


def python_violations(source: str, filename: str) -> set[int]:
    lines = set()
    formatted_strings = (ast.JoinedStr, getattr(ast, "TemplateStr", ast.JoinedStr))
    for node in ast.walk(ast.parse(source, filename=filename)):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            literal = node.value
        elif isinstance(node, formatted_strings):
            literal = "".join(part.value for part in node.values if isinstance(part, ast.Constant))
        else:
            continue
        if len(HAN.findall(literal)) >= 4:
            lines.add(node.lineno)
    return lines


def frontend_violations(root: Path, paths: list[str]) -> list[list]:
    result = subprocess.run(
        ["node", "-e", TS_LITERAL_CHECK],
        cwd=root,
        input=json.dumps({"paths": paths, "han": HAN_PATTERN}),
        encoding="utf-8",
        capture_output=True,
        check=True,
    )
    return json.loads(result.stdout)


def locale_entries(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for entry in value.values():
            yield from locale_entries(entry)
    elif isinstance(value, list):
        for entry in value:
            yield from locale_entries(entry)


def check_repository(root: Path) -> list[str]:
    allowlist = load_allowlist(root / "scripts/no_fakes_allowlist.txt")
    terms = {
        line.strip()
        for file in (root / "evals/gold").glob("*/forbidden_terms.txt")
        for line in read_text(file).splitlines()
        if line.strip()
    }
    registry = root / PROMPTS / "variables.json"
    variables = json.loads(read_text(registry)) if registry.is_file() else {}
    if not isinstance(variables, dict):
        raise ValueError("libs/prompts/v3/variables.json: expected an object keyed by variable name")

    problems = []
    frontend_paths = []
    for relative, source in product_texts(root):
        path = relative.as_posix()
        if path not in allowlist:
            for line, text in enumerate(source.splitlines(), 1):
                match = BANNED.search(text)
                if match:
                    problems.append(f"{path}:{line}: banned identifier {match.group()!r}")
        for term in sorted(terms):
            if term in source:
                problems.append(f"{path}: forbidden topic term {term!r}")
        if relative.is_relative_to(PROMPTS) and relative != PROMPTS / "variables.json":
            for name in sorted(set(PLACEHOLDER.findall(source)) - variables.keys()):
                problems.append(f"{path}: unregistered prompt variable {name!r}")

        parts = relative.parts
        if relative.suffix == ".py" and parts[:3] == ("services", "api", "app") and parts[3] in PYTHON_FEATURES:
            for line in sorted(python_violations(source, path)):
                problems.append(f"{path}:{line}: string literal contains at least four Han characters")
        if relative.suffix in TS_EXTENSIONS and parts[:4] == ("apps", "web", "src", "features") and parts[4] in WEB_FEATURES:
            frontend_paths.append(path)

    if frontend_paths:
        for path, line in frontend_violations(root, frontend_paths):
            problems.append(f"{path}:{line}: string literal contains at least four Han characters")

    for path in LOCALES:
        file = root / path
        if not file.is_file():
            continue
        data = json.loads(read_text(file))
        if any(len(entry) > 60 for entry in locale_entries(data)):
            problems.append(f"{path}: locale entry exceeds 60 characters")
        serialized = json.dumps(data, ensure_ascii=False)
        for term in sorted(terms):
            if term in serialized:
                problems.append(f"{path}: forbidden topic term {term!r}")
    return list(dict.fromkeys(problems))


def main() -> int:
    try:
        problems = check_repository(Path(__file__).resolve().parents[1])
    except subprocess.CalledProcessError as exc:
        print("Could not check frontend literals with the installed TypeScript parser.")
        print(exc.stderr.strip())
        return 1
    except (OSError, SyntaxError, ValueError) as exc:
        print(f"Could not check product sources: {exc}")
        return 1
    if problems:
        print("\n".join(problems))
        return 1
    print("Product source checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())