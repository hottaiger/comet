from __future__ import annotations

import os
import re
import shlex
import subprocess
from pathlib import Path

from scaffold.python.validation.core import write_test_results


WORKSPACE = Path(os.environ.get("TASK_WORKSPACE", ".")).resolve()
LESS = WORKSPACE / "src/violation-repair.less"
TSX = WORKSPACE / "src/ViolationRepair.tsx"


def run_tool(label: str, env_name: str, default: str, target: Path) -> tuple[bool, str]:
    command = shlex.split(os.environ.get(env_name, default)) + [str(target)]
    try:
        result = subprocess.run(command, cwd=WORKSPACE, capture_output=True, text=True, timeout=45)
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, f"[{label}-command] {error}"
    output = (result.stdout + result.stderr).strip()
    return result.returncode == 0, output[-1200:]


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
    if re.search(r"\b(?:gap|row-gap|column-gap)\s*:", source):
        failed.append("[forbidden-property] 公共 Less 不得使用 gap/row-gap/column-gap")
    else:
        passed.append("[forbidden-property] 未使用 gap")
    if re.search(r"&\s*(?::|__|--)", source) or re.search(r"^[ \t]+\.[^\n{]+\{", source, re.M):
        failed.append("[top-level-single-selector] 不得使用 Less 嵌套、& 或后代规则")
    else:
        passed.append("[top-level-single-selector] 所有规则均为顶层规则")
    if re.search(r":{1,2}[a-z-]+", source):
        failed.append("[bem-selector] 公共 Less 不得使用伪类或伪元素")
    else:
        passed.append("[bem-selector] 未使用伪类或伪元素")
    line_heights = re.findall(r"line-height\s*:\s*([^;]+);", source)
    invalid_line_heights = [value for value in line_heights if not re.fullmatch(r"-?\d+(?:\.\d+)?px\s*", value.strip())]
    if invalid_line_heights:
        failed.append("[line-height-px] 公共 Less 的 line-height 必须是 px 数值")
    else:
        passed.append("[line-height-px] line-height 使用 px 数值")
    has_text_classes = all(
        re.search(rf"<Text[\s\S]{{0,400}}?className\s*=[\s\S]{{0,400}}?{re.escape(class_name)}", tsx)
        for class_name in ("service-card__title", "service-card__action")
    )
    has_last_index = bool(re.search(r"\b\w+\s*===?\s*\w+\.length\s*-\s*1\b", tsx))
    if has_text_classes and classes_are_co_mounted(tsx, "service-card__action", "service-card__action--last") and has_last_index:
        passed.append("[bem-modifier] TSX 为末项操作同挂 --last modifier")
    else:
        failed.append("[bem-modifier] TSX 必须在 Text 上应用操作类，并以末项判断同挂 service-card__action--last")
    return passed, failed


def main() -> None:
    passed, failed = [], []
    try:
        if not LESS.exists() or not TSX.exists():
            failed.append("[artifact] 缺少 src/violation-repair.less 或 src/ViolationRepair.tsx")
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
