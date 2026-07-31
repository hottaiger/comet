from __future__ import annotations

import os
import re
import shlex
import subprocess
from pathlib import Path

from scaffold.python.validation.core import write_test_results


WORKSPACE = Path(os.environ.get("TASK_WORKSPACE", ".")).resolve()
LESS = WORKSPACE / "src" / "vehicle-list.less"
TSX = WORKSPACE / "src" / "vehicle-list.tsx"


def _run(command_key: str, default: str, target: Path) -> tuple[bool, str]:
    command = os.environ.get(command_key, default).format(file=target.as_posix())
    result = subprocess.run(
        shlex.split(command), cwd=WORKSPACE, text=True, capture_output=True, check=False
    )
    output = "\n".join(value for value in (result.stdout.strip(), result.stderr.strip()) if value)
    return result.returncode == 0, output[-1200:]


def _rule_body(less: str, selector: str) -> str:
    match = re.search(rf"^{re.escape(selector)}\s*\{{(?P<body>.*?)^\}}", less, re.MULTILINE | re.DOTALL)
    return match.group("body") if match else ""


def main() -> None:
    passed: list[str] = []
    failed: list[str] = []
    try:
        if not LESS.exists():
            failed.append("artifact: src/vehicle-list.less missing")
            less = ""
        else:
            less = LESS.read_text(encoding="utf-8")
        if not TSX.exists():
            failed.append("artifact: src/vehicle-list.tsx missing")
            tsx = ""
        else:
            tsx = TSX.read_text(encoding="utf-8")

        if less:
            ok, output = _run(
                "DETAIL_LESS_CHECKER_COMMAND",
                "node scripts/check-public-less.mjs {file}",
                LESS,
            )
            (passed if ok else failed).append(
                "check-public-less: passed" if ok else f"check-public-less rule failure: {output}"
            )
            ok, output = _run(
                "DETAIL_LESS_STYLELINT_COMMAND",
                "stylelint --config .stylelintrc.json {file}",
                LESS,
            )
            (passed if ok else failed).append(
                "stylelint: passed" if ok else f"stylelint rule failure: {output}"
            )

        item_body = _rule_body(less, ".vehicle-list__item")
        last_body = _rule_body(less, ".vehicle-list__item--last")
        if not re.search(r"\b(?:gap|row-gap|column-gap)\s*:", less) and ":" not in "\n".join(
            line.split("{")[0] for line in less.splitlines() if "{" in line
        ):
            passed.append("list-spacing: no gap properties or pseudo selectors")
        else:
            failed.append("list-spacing rule: gap, row-gap, column-gap, and pseudo selectors are forbidden")
        if re.search(r"margin-bottom\s*:\s*12px\s*;", item_body) and re.search(
            r"margin-bottom\s*:\s*0\s*;", last_body
        ):
            passed.append("last-item-margin: item spacing and --last reset are present")
        else:
            failed.append("last-item-margin rule: vehicle-list__item needs margin-bottom: 12px and vehicle-list__item--last needs margin-bottom: 0")
        modifier_condition = re.compile(
            r"index\s*===\s*vehicles\.length\s*-\s*1\s*\?\s*['\"]\s+vehicle-list__item--last['\"]\s*:\s*['\"]['\"]"
        )
        item_class = re.compile(
            r"<View\b[^>]*\bclassName\s*=\s*\{(?P<expression>[\s\S]{0,400}?)\}",
            re.DOTALL,
        )
        item_expressions = [match.group("expression") for match in item_class.finditer(tsx)]
        if any(
            "vehicle-list__item" in expression and "vehicle-list__item--last" in expression
            for expression in item_expressions
        ) and modifier_condition.search(tsx):
            passed.append("modifier-attachment: last modifier is co-mounted with item base class")
        else:
            failed.append("modifier-attachment rule: map output must append vehicle-list__item--last to vehicle-list__item for the final item")
    except Exception as exc:
        failed.append(f"validator-exception rule: {type(exc).__name__}: {exc}")
    finally:
        write_test_results({"passed": passed, "failed": failed})


if __name__ == "__main__":
    main()
