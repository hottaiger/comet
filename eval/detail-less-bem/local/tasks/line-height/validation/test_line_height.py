"""Validator for the line-height public Less task."""

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
LESS = ROOT / "src" / "vehicle-summary.less"
TSX = ROOT / "src" / "VehicleSummary.tsx"


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
            failed.append("[artifact-presence] src/VehicleSummary.tsx and src/vehicle-summary.less are required")
        else:
            less = LESS.read_text(encoding="utf-8")
            tsx = TSX.read_text(encoding="utf-8")
            values = re.findall(r"\bline-height\s*:\s*([^;]+)", less)
            if not values:
                failed.append("[line-height-px] public Less must contain explicit line-height declarations")
            else:
                invalid = [value.strip() for value in values if not re.fullmatch(r"-?\d+(?:\.\d+)?px", value.strip(), re.I)]
                if invalid:
                    failed.append(f"[line-height-px] non-pixel line-height values: {', '.join(invalid)}")
                else:
                    passed.append("[line-height-px] all line-height values use px")
            if not re.findall(r"<Text\b[^>]*\bclassName=", tsx):
                failed.append("[text-explicit-style] every rendered label must use a styled Text component")
            else:
                passed.append("[text-explicit-style] styled Text components present")
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
