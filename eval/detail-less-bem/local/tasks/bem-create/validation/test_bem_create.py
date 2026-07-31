from __future__ import annotations

import os
import re
import shlex
import subprocess
from pathlib import Path

from scaffold.python.validation.core import write_test_results


WORKSPACE = Path(os.environ.get("TASK_WORKSPACE", ".")).resolve()
LESS = WORKSPACE / "src" / "vehicle-summary.less"
TSX = WORKSPACE / "src" / "vehicle-summary.tsx"


def _run(command_key: str, default: str, target: Path) -> tuple[bool, str]:
    command = os.environ.get(command_key, default).format(file=target.as_posix())
    result = subprocess.run(
        shlex.split(command), cwd=WORKSPACE, text=True, capture_output=True, check=False
    )
    output = "\n".join(value for value in (result.stdout.strip(), result.stderr.strip()) if value)
    return result.returncode == 0, output[-1200:]


def main() -> None:
    passed: list[str] = []
    failed: list[str] = []
    try:
        if not LESS.exists():
            failed.append("artifact: src/vehicle-summary.less missing")
            less = ""
        else:
            less = LESS.read_text(encoding="utf-8")
        if not TSX.exists():
            failed.append("artifact: src/vehicle-summary.tsx missing")
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

        selectors = [line.strip().split(" {")[0] for line in less.splitlines() if line.strip().endswith("{")]
        required = {
            ".vehicle-summary",
            ".vehicle-summary__title",
            ".vehicle-summary__price",
            ".vehicle-summary--disabled",
        }
        if required.issubset(selectors) and all(selector.startswith(".vehicle-summary") for selector in selectors):
            passed.append("bem-create: one vehicle-summary BEM namespace")
        else:
            failed.append("bem-create rule: selectors must be vehicle-summary title, price, and disabled BEM selectors only")

        root_class = re.compile(
            r"<View\b[^>]*\bclassName\s*=\s*\{(?P<expression>[\s\S]{0,400}?)\}",
            re.DOTALL,
        )
        root_expressions = [match.group("expression") for match in root_class.finditer(tsx)]
        if any(
            "disabled" in expression
            and "vehicle-summary" in expression
            and "vehicle-summary--disabled" in expression
            for expression in root_expressions
        ):
            passed.append("modifier-attachment: root base and modifier are co-mounted")
        else:
            failed.append("modifier-attachment rule: vehicle-summary--disabled must be co-mounted with vehicle-summary on the root View")
        text_classes = re.findall(r"<Text\b[^>]*\bclassName\s*=\s*['\"]([^'\"]+)['\"][^>]*>", tsx)
        if {"vehicle-summary__title", "vehicle-summary__price"}.issubset(text_classes):
            passed.append("text-class: title and price use explicit Text styling")
        else:
            failed.append("text-class rule: title and price must be Text with vehicle-summary__title and vehicle-summary__price")
    except Exception as exc:
        failed.append(f"validator-exception rule: {type(exc).__name__}: {exc}")
    finally:
        write_test_results({"passed": passed, "failed": failed})


if __name__ == "__main__":
    main()
