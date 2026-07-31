from __future__ import annotations

import os
import re
import shlex
import subprocess
from pathlib import Path

from scaffold.python.validation.core import write_test_results


WORKSPACE = Path(os.environ.get("TASK_WORKSPACE", ".")).resolve()
LESS = WORKSPACE / "src/equal-width-row.less"
TSX = WORKSPACE / "src/EqualWidthRow.tsx"


def run_tool(label: str, env_name: str, default: str, target: Path) -> tuple[bool, str]:
    command = shlex.split(os.environ.get(env_name, default)) + [str(target)]
    try:
        result = subprocess.run(command, cwd=WORKSPACE, capture_output=True, text=True, timeout=45)
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, f"[{label}-command] {error}"
    output = (result.stdout + result.stderr).strip()
    return result.returncode == 0, output[-1200:]


def rule_body(source: str, selector: str) -> str:
    match = re.search(rf"^{re.escape(selector)}\s*\{{([^{{}}]*)\}}", source, re.M)
    return match.group(1) if match else ""


def classes_are_co_mounted(tsx: str, base: str, modifier: str) -> bool:
    for match in re.finditer(r"className\s*=", tsx):
        expression = tsx[match.end() : match.end() + 600]
        if base in expression and modifier in expression:
            return True
    for variable in re.findall(r"(?:const|let)\s+(\w+)\s*=", tsx):
        assignment = re.search(rf"(?:const|let)\s+{re.escape(variable)}\s*=([\s\S]{{0,600}}?);", tsx)
        if assignment and base in assignment.group(1) and modifier in assignment.group(1):
            if re.search(rf"className\s*=\s*\{{\s*{re.escape(variable)}\s*\}}", tsx):
                return True
    return False


def check_contract(source: str, tsx: str) -> tuple[list[str], list[str]]:
    passed, failed = [], []
    row = rule_body(source, ".entry-row")
    card = rule_body(source, ".entry-card")
    last = rule_body(source, ".entry-card--last")
    if re.search(r"display\s*:\s*flex", row) and re.search(r"flex-direction\s*:\s*row", row):
        passed.append("[horizontal-flex] entry-row 显式横向 flex")
    else:
        failed.append("[horizontal-flex] entry-row 必须同时声明 display: flex 与 flex-direction: row")
    if re.search(r"flex\s*:\s*1(?:\s*;|\s*$)", card):
        passed.append("[equal-width] entry-card 使用 flex: 1")
    else:
        failed.append("[equal-width] entry-card 必须使用 flex: 1")
    if re.search(r"margin-right\s*:\s*[^;]+", card) and re.search(r"margin-right\s*:\s*0", last):
        passed.append("[gap-replacement] 用 margin-right 与 --last 表达固定间距")
    else:
        failed.append("[gap-replacement] entry-card 与 entry-card--last 必须分别声明 margin-right 和 margin-right: 0")
    bar = rule_body(source, ".entry-card--bar")
    has_single_card_condition = bool(re.search(r"\b\w+\.length\s*={2,3}\s*1\b|\b\w+\.length\s*<\s*2\b", tsx))
    if has_single_card_condition and classes_are_co_mounted(tsx, "entry-card", "entry-card--bar") and re.search(r"height\s*:\s*\d+px", bar):
        passed.append("[single-card-fallback] 单卡通过 entry-card--bar 回退为整行横条")
    else:
        failed.append("[single-card-fallback] TSX 必须针对单卡同挂 entry-card--bar，Less 必须定义其横条高度")
    if re.search(r"\b(?:gap|row-gap|column-gap)\s*:", source):
        failed.append("[forbidden-property] 公共 Less 不得使用 gap/row-gap/column-gap")
    else:
        passed.append("[forbidden-property] 未使用 gap")
    if re.search(r"^\s*\.[^{\n]+(?:\s+|>)\.[^{\n]+\{", source, re.M):
        failed.append("[top-level-single-selector] 公共 Less 不得使用后代或子代选择器")
    else:
        passed.append("[top-level-single-selector] 未使用后代或子代选择器")
    if classes_are_co_mounted(tsx, "entry-card", "entry-card--last") and re.search(r"\b\w+\s*===?\s*\w+\.length\s*-\s*1\b", tsx):
        passed.append("[bem-modifier] TSX 为末项同挂 --last modifier")
    else:
        failed.append("[bem-modifier] TSX 必须以末项判断为 entry-card 同挂 --last modifier")
    return passed, failed


def main() -> None:
    passed, failed = [], []
    try:
        if not LESS.exists() or not TSX.exists():
            failed.append("[artifact] 缺少 src/equal-width-row.less 或 src/EqualWidthRow.tsx")
        else:
            contract_passed, contract_failed = check_contract(LESS.read_text(encoding="utf-8"), TSX.read_text(encoding="utf-8"))
            passed.extend(contract_passed)
            failed.extend(contract_failed)
            ok, output = run_tool("check-public-less", "DETAIL_LESS_CHECKER_COMMAND", "node scripts/check-public-less.mjs", LESS)
            (passed if ok else failed).append("[check-public-less] 通过" if ok else f"[check-public-less] {output}")
            ok, output = run_tool("stylelint", "DETAIL_LESS_STYLELINT_COMMAND", "stylelint --config .stylelintrc.json", LESS)
            (passed if ok else failed).append("[stylelint] 通过" if ok else f"[stylelint] {output}")
    except Exception as error:
        failed.append(f"[validator-execution] {error}")
    finally:
        write_test_results({"passed": passed, "failed": failed})


if __name__ == "__main__":
    main()
