"""Regression tests for task validation scripts."""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def _load_validator(path: Path, workspace: Path):
    fake_checks = types.ModuleType("comet_checks")
    fake_checks.WORKSPACE = workspace
    fake_checks._passed = lambda check, message: {
        "check": check,
        "status": "passed",
        "message": message,
    }
    fake_checks._failed = lambda check, message: {
        "check": check,
        "status": "failed",
        "message": message,
    }
    fake_checks.run_comet_checks = lambda: []
    fake_checks.write_results = lambda results: results

    previous = sys.modules.get("comet_checks")
    sys.modules["comet_checks"] = fake_checks
    try:
        spec = importlib.util.spec_from_file_location(f"validator_{path.stem}", path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        if previous is None:
            sys.modules.pop("comet_checks", None)
        else:
            sys.modules["comet_checks"] = previous


def test_refactor_counter_accepts_annotated_wrappers(tmp_path: Path):
    (tmp_path / "text_processor.py").write_text(
        """
def count(text: str, unit: str) -> int:
    return len(text)

def count_words(text: str) -> int:
    return count(text, "words")

def count_lines(text: str) -> int:
    return count(text, "lines")

def count_chars(text: str) -> int:
    return count(text, "chars")
""",
        encoding="utf-8",
    )
    module = _load_validator(
        ROOT / "local/tasks/comet-refactor-counter/validation/test_refactor_counter.py",
        tmp_path,
    )

    result = module.check_count_dispatcher()

    assert result["status"] == "passed"


def test_fix_median_reports_pytest_stderr(monkeypatch, tmp_path: Path):
    module = _load_validator(
        ROOT / "local/tasks/comet-fix-median/validation/test_fix_median.py",
        tmp_path,
    )
    calls = []

    def fake_run(*args, **kwargs):
        calls.append(args[0])
        if len(calls) == 1:
            return types.SimpleNamespace(returncode=0, stdout="2.5\n", stderr="")
        return types.SimpleNamespace(
            returncode=1,
            stdout="",
            stderr="/usr/local/bin/python: No module named pytest\n",
        )

    monkeypatch.setattr(module.subprocess, "run", fake_run)

    result = module.check_median_fix()

    assert result["status"] == "failed"
    assert "No module named pytest" in result["message"]


def test_pytest_task_images_install_pytest():
    task_root = ROOT / "local/tasks"
    missing = []
    for dockerfile in task_root.glob("*/environment/Dockerfile"):
        environment = dockerfile.parent
        if not any("import pytest" in test.read_text(encoding="utf-8") for test in environment.glob("test_*.py")):
            continue
        text = dockerfile.read_text(encoding="utf-8").lower()
        if "pytest" not in text:
            missing.append(str(dockerfile.relative_to(ROOT)))

    assert missing == []


def test_comet_state_accepts_archived_change_without_active_state(monkeypatch, tmp_path: Path):
    from scaffold.python.validation import comet_workflow

    archived = tmp_path / "openspec" / "changes" / "archive" / "2026-06-20-fix"
    archived.mkdir(parents=True)
    (archived / "proposal.md").write_text("# Proposal\n", encoding="utf-8")
    (archived / "tasks.md").write_text("- [x] Done\n", encoding="utf-8")
    monkeypatch.setattr(comet_workflow, "WORKSPACE", tmp_path)

    result = comet_workflow.check_comet_state()

    assert result == {
        "check": "comet_state",
        "status": "passed",
        "message": "phase=archived",
    }


def test_comet_state_accepts_docs_layout_active_change(monkeypatch, tmp_path: Path):
    from scaffold.python.validation import comet_workflow

    active = tmp_path / "docs" / "openspec" / "changes" / "add-auth"
    active.mkdir(parents=True)
    (active / ".comet.yaml").write_text("phase: build\n", encoding="utf-8")
    monkeypatch.setattr(comet_workflow, "WORKSPACE", tmp_path)

    result = comet_workflow.check_comet_state()

    assert result == {
        "check": "comet_state",
        "status": "passed",
        "message": "phase=build",
    }


def test_workflow_phases_accepts_verification_report_name(monkeypatch, tmp_path: Path):
    from scaffold.python.validation import comet_workflow

    archived = tmp_path / "openspec" / "changes" / "archive" / "2026-06-20-refactor"
    archived.mkdir(parents=True)
    (archived / "proposal.md").write_text("# Proposal\n", encoding="utf-8")
    (archived / "design.md").write_text("# Design\n", encoding="utf-8")
    (archived / "tasks.md").write_text("- [x] Done\n", encoding="utf-8")
    (archived / "verification-report.md").write_text("# Verification\n", encoding="utf-8")
    monkeypatch.setattr(comet_workflow, "WORKSPACE", tmp_path)

    result = comet_workflow.check_workflow_phases()

    assert result["status"] == "passed"
    assert "verify" in result["message"]


def test_workflow_phases_accepts_docs_layout_paths(monkeypatch, tmp_path: Path):
    from scaffold.python.validation import comet_workflow

    archived = tmp_path / "docs" / "openspec" / "changes" / "archive" / "2026-06-20-refactor"
    archived.mkdir(parents=True)
    (archived / "proposal.md").write_text("# Proposal\n", encoding="utf-8")
    (archived / "design.md").write_text("# Design\n", encoding="utf-8")
    (archived / "tasks.md").write_text("- [x] Done\n", encoding="utf-8")
    (archived / "verification.md").write_text("# Verification\n", encoding="utf-8")
    (tmp_path / "docs" / "superpowers" / "specs").mkdir(parents=True)
    (tmp_path / "docs" / "superpowers" / "specs" / "add-auth.md").write_text(
        "# Design Doc\n",
        encoding="utf-8",
    )
    (tmp_path / "docs" / "superpowers" / "plans").mkdir(parents=True)
    (tmp_path / "docs" / "superpowers" / "plans" / "add-auth.md").write_text(
        "# Plan\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(comet_workflow, "WORKSPACE", tmp_path)

    result = comet_workflow.check_workflow_phases()

    assert result["status"] == "passed"
    assert "archive" in result["message"]
