"""Validator for the horizontal-layout public Less task."""

import json
import os
import re
import shlex
import subprocess
from pathlib import Path

try:
    from scaffold.python.validation.core import write_test_results
except ModuleNotFoundError:
    def write_test_results(results: dict, path: str = "_test_results.json") -> None:
        Path(path).write_text(json.dumps(results), encoding="utf-8")

ROOT = Path.cwd()
LESS = ROOT / "src" / "entrance-row.less"
TSX = ROOT / "src" / "EntranceRow.tsx"


def _command(variable: str, default: str, target: Path) -> list[str]:
    command = os.environ.get(variable, default)
    return shlex.split(command.replace("{file}", str(target))) if "{file}" in command else shlex.split(command) + [str(target)]


def _run(variable: str, default: str, target: Path, rule: str, failed: list[str], passed: list[str]) -> None:
    result = subprocess.run(_command(variable, default, target), cwd=ROOT, capture_output=True, text=True)
    if result.returncode:
        output = "\n".join(part for part in (result.stdout, result.stderr) if part).strip()[-800:]
        failed.append(f"[{rule}] {output or 'command failed'}")
    else:
        passed.append(f"[{rule}] passed")


def main() -> int:
    passed: list[str] = []
    failed: list[str] = []
    try:
        if not LESS.exists() or not TSX.exists():
            failed.append("[artifact-presence] src/EntranceRow.tsx and src/entrance-row.less are required")
        else:
            less = LESS.read_text(encoding="utf-8")
            tsx = TSX.read_text(encoding="utf-8")
            row = re.search(r"\.entrance-row\s*\{(?P<body>[^}]*)\}", less, re.S)
            card = re.search(r"\.entrance-row__card\s*\{(?P<body>[^}]*)\}", less, re.S)
            if not row or not re.search(r"\bdisplay\s*:\s*flex\s*;", row.group("body")) or not re.search(r"\bflex-direction\s*:\s*row\s*;", row.group("body")):
                failed.append("[horizontal-flex-row] .entrance-row must declare display: flex and flex-direction: row")
            else:
                passed.append("[horizontal-flex-row] explicit row flex layout")
            if not card or not re.search(r"\bflex\s*:\s*1\s*;", card.group("body")):
                failed.append("[equal-width-cards] .entrance-row__card must declare flex: 1")
            else:
                passed.append("[equal-width-cards] cards use flex: 1")
            class_names = [
                quoted[0] or quoted[1]
                for quoted in re.findall(
                    r"<View\b[^>]*\bclassName\s*=\s*(?:\"([^\"]*)\"|'([^']*)')",
                    tsx,
                )
            ]
            card_class_lists = [classes.split() for classes in class_names if "entrance-row__card" in classes.split()]
            if len(card_class_lists) < 2:
                failed.append("[last-card-modifier] TSX must render at least two entrance-row__card elements")
            elif {"entrance-row__card", "entrance-row__card--last"}.issubset(card_class_lists[-1]):
                passed.append("[last-card-modifier] final card co-mounts base class and --last modifier")
            else:
                failed.append("[last-card-modifier] final entrance-row__card must co-mount entrance-row__card and entrance-row__card--last")
            _run("DETAIL_LESS_CHECKER_CMD", "node scripts/check-public-less.mjs", LESS, "public-less-checker", failed, passed)
            _run("DETAIL_LESS_STYLELINT_CMD", "stylelint --config .stylelintrc.json", LESS, "stylelint", failed, passed)
    except Exception as error:
        failed.append(f"[validator-runtime] {type(error).__name__}: {error}")
    finally:
        results = {"passed": passed, "failed": failed}
        write_test_results(results)
        print(json.dumps(results))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
