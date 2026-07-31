from __future__ import annotations

import os
import re
import shlex
import subprocess
from pathlib import Path

from scaffold.python.validation.core import write_test_results


WORKSPACE = Path(os.environ.get("TASK_WORKSPACE", ".")).resolve()
LESS = WORKSPACE / "src/platform-condition.less"
TSX = WORKSPACE / "src/PlatformCondition.tsx"


def run_tool(label: str, env_name: str, default: str, target: Path) -> tuple[bool, str]:
    command = shlex.split(os.environ.get(env_name, default)) + [str(target)]
    try:
        result = subprocess.run(command, cwd=WORKSPACE, capture_output=True, text=True, timeout=45)
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, f"[{label}-command] {error}"
    output = (result.stdout + result.stderr).strip()
    return result.returncode == 0, output[-1200:]


def class_is_applied(tsx: str, class_name: str) -> bool:
    escaped = re.escape(class_name)
    if re.search(rf"className\s*=\s*(?:['\"][^'\"]*\b{escaped}\b[^'\"]*['\"]|`[^`]*\b{escaped}\b[^`]*`|\{{[^\n]*\b{escaped}\b)", tsx):
        return True
    variables = re.findall(rf"(?:const|let)\s+(\w+)\s*=\s*[\s\S]{{0,400}}?\b{escaped}\b", tsx)
    return any(re.search(rf"className\s*=\s*\{{\s*{re.escape(variable)}\s*\}}", tsx) for variable in variables)


def check_contract(source: str, tsx: str) -> tuple[list[str], list[str]]:
    passed, failed = [], []
    directives = re.findall(r"/\*\s*#([A-Za-z]+)(?:\s+([^*]+?))?\s*\*/", source)
    invalid = [name for name, _ in directives if name not in {"ifdef", "ifndef", "endif"}]
    invalid += [platform for name, platforms in directives if name != "endif" for platform in platforms.split() if platform not in {"rn", "h5", "weapp"}]
    if invalid:
        failed.append(f"[platform-condition] 仅允许小写 #ifdef/#ifndef/#endif 与 rn/h5/weapp：{', '.join(invalid)}")
    else:
        passed.append("[platform-condition] 条件编译标记与平台名均为小写")
    h5_shadow = re.search(r"/\*\s*#ifdef\s+h5\s*\*/(?:(?!/\*\s*#endif\s*\*/).)*box-shadow\s*:", source, re.S)
    if h5_shadow:
        passed.append("[forbidden-property] box-shadow 仅位于 h5 条件块")
    else:
        failed.append("[forbidden-property] 缺少仅限 h5 的 box-shadow 条件块")
    if re.search(r"/\*\s*#(?:ifdef|ifndef)\s+rn\s*\*/(?:(?!/\*\s*#endif\s*\*/).)*box-shadow\s*:", source, re.S):
        failed.append("[forbidden-property] rn 条件块不得包含 box-shadow")
    else:
        passed.append("[forbidden-property] rn 条件块无 box-shadow")
    if class_is_applied(tsx, "platform-card") and class_is_applied(tsx, "platform-card__title"):
        passed.append("[bem-selector] TSX 保留平台卡片 BEM 类")
    else:
        failed.append("[bem-selector] TSX 必须将 platform-card 与 platform-card__title 应用于对应元素")
    return passed, failed


def main() -> None:
    passed, failed = [], []
    try:
        if not LESS.exists() or not TSX.exists():
            failed.append("[artifact] 缺少 src/platform-condition.less 或 src/PlatformCondition.tsx")
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
