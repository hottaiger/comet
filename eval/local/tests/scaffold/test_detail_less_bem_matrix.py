"""Contract tests for the detail-less-bem repeated evaluation matrix."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
from pathlib import Path

import pytest

from scaffold.python.tasks import load_task


EVAL_ROOT = Path(__file__).resolve().parents[3]
BENCH_ROOT = EVAL_ROOT / "detail-less-bem"
REPORT_PATH = BENCH_ROOT / "report.py"
RUN_MATRIX_PATH = BENCH_ROOT / "run-matrix.sh"


def _load_report_module():
    spec = importlib.util.spec_from_file_location("detail_less_bem_report", REPORT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_attempt(
    run_root: Path,
    task: str,
    treatment: str,
    rep: int,
    *,
    status: str = "included",
    hard_pass: bool | None = True,
    duration: float = 10.0,
    failed_rules: list[str] | None = None,
    soft_score: float | None = 2.0,
) -> None:
    attempt_dir = run_root / "attempts" / task / treatment / f"rep-{rep}"
    attempt_dir.mkdir(parents=True)
    (attempt_dir / "stdout.log").write_text("stdout", encoding="utf-8")
    (attempt_dir / "stderr.log").write_text("", encoding="utf-8")
    (attempt_dir / "metadata.json").write_text(
        json.dumps(
            {
                "task": task,
                "treatment": treatment,
                "rep": rep,
                "variant": f"variant-{rep}",
                "status": status,
                "hard_pass": hard_pass,
                "duration_seconds": duration,
                "failed_rules": failed_rules or [],
                "soft_score": soft_score,
                "paths": {
                    "stdout": str(attempt_dir / "stdout.log"),
                    "stderr": str(attempt_dir / "stderr.log"),
                },
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def test_all_task_variants_render_one_marker_free_prompt(monkeypatch):
    tasks_dir = BENCH_ROOT / "local" / "tasks"
    monkeypatch.setenv("BENCH_TASKS_DIR", str(tasks_dir))

    for task_name in sorted(path.name for path in tasks_dir.iterdir() if path.is_dir()):
        task = load_task(task_name, tasks_dir)
        assert len(task.config.instruction_variants) == 3
        for variant in task.config.instruction_variants:
            prompt = task.render_prompt(task_variant=variant)
            assert "TASK_VARIANT" not in prompt
            assert prompt.strip()


def test_matrix_plan_has_all_48_attempts_and_balanced_variants():
    report = _load_report_module()

    plan = report.build_matrix_plan(BENCH_ROOT)

    assert len(plan) == 48
    assert len({(item["task"], item["treatment"], item["rep"]) for item in plan}) == 48
    assert {item["treatment"] for item in plan} == {"CONTROL", "DETAIL_LESS_BEM"}
    for task in {item["task"] for item in plan}:
        control = [
            item["variant"]
            for item in plan
            if item["task"] == task and item["treatment"] == "CONTROL"
        ]
        treatment = [
            item["variant"]
            for item in plan
            if item["task"] == task and item["treatment"] == "DETAIL_LESS_BEM"
        ]
        assert control == treatment
        assert len(set(control)) == 3
    assert report.execution_fingerprint(
        BENCH_ROOT / "local" / "treatments" / "CONTROL.toml"
    ) == report.execution_fingerprint(BENCH_ROOT / "local" / "treatments" / "DETAIL_LESS_BEM.toml")


@pytest.mark.parametrize(
    ("returncode", "stderr", "runner_result", "expected_status", "reason"),
    [
        (0, "", {"passed": ["stylelint"], "failed": []}, "included", None),
        (
            1,
            "Validation failed",
            {"passed": [], "failed": ["line-height: failed"]},
            "included",
            None,
        ),
        (1, "Docker not available", None, "excluded", "docker_unavailable"),
        (1, "authentication failed", None, "excluded", "authentication_failure"),
        (1, "HTTP 401 unauthorized", None, "excluded", "authentication_failure"),
        (0, "Cost: $0.4012", {"passed": [], "failed": []}, "included", None),
        (
            0,
            "SKIPPED [5] ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN not set",
            None,
            "excluded",
            "authentication_failure",
        ),
        (1, "connection timed out", None, "excluded", "network_failure"),
        (1, "collection error", None, "flagged", "runner_failure"),
        (
            1,
            "authentication failed",
            {"passed": [], "failed": ["validator interrupted"]},
            "excluded",
            "authentication_failure",
        ),
        (
            1,
            "Docker not available",
            {"passed": [], "failed": ["validator interrupted"]},
            "excluded",
            "docker_unavailable",
        ),
        (
            1,
            "network is unreachable",
            {"passed": [], "failed": ["validator interrupted"]},
            "excluded",
            "network_failure",
        ),
        (
            124,
            "Timeout after 600s",
            {"passed": [], "failed": ["agent timed out"]},
            "excluded",
            "outer_timeout",
        ),
        (
            124,
            "Outer timeout after 900s",
            {"passed": [], "failed": ["validator interrupted"]},
            "excluded",
            "outer_timeout",
        ),
    ],
)
def test_attempt_classification(returncode, stderr, runner_result, expected_status, reason):
    report = _load_report_module()

    classification = report.classify_attempt(returncode, "", stderr, runner_result)

    assert classification["status"] == expected_status
    assert classification.get("reason") == reason


def test_sample_quality_network_exclusion_overrides_runner_result():
    report = _load_report_module()

    classification = report.classify_attempt(
        1,
        "",
        "",
        {"passed": [], "failed": ["validator unavailable"]},
        {"status": "excluded", "reason_code": "network_failure"},
    )

    assert classification == {"status": "excluded", "reason": "network_failure"}


def test_sample_quality_runner_startup_failure_is_flagged():
    report = _load_report_module()

    classification = report.classify_attempt(
        1,
        "",
        "",
        {"passed": [], "failed": ["No JSON output"]},
        {"status": "flagged", "reason_code": "partial_observability"},
    )

    assert classification == {"status": "flagged", "reason": "partial_observability"}


@pytest.mark.parametrize(
    "stderr",
    [
        "Error: Cannot find module '/workspace/claude'",
        "claude: command not found",
    ],
)
def test_missing_claude_cli_is_flagged_not_counted_as_hard_failure(stderr: str):
    report = _load_report_module()

    classification = report.classify_attempt(1, "", stderr, None)

    assert classification == {
        "status": "flagged",
        "reason": "agent_runner_startup_failure",
    }


def test_reclassify_run_uses_scaffold_sample_quality(tmp_path: Path):
    report = _load_report_module()
    attempt = tmp_path / "attempts" / "bem-create" / "CONTROL" / "rep-1"
    reports = tmp_path / "reports"
    reports.mkdir(parents=True)
    stdout = attempt / "stdout.log"
    stderr = attempt / "stderr.log"
    runner = attempt / "runner_result.json"
    attempt.mkdir(parents=True)
    stdout.write_text("", encoding="utf-8")
    stderr.write_text("", encoding="utf-8")
    runner.write_text(json.dumps({"passed": [], "failed": ["build failed"]}), encoding="utf-8")
    report_path = reports / "attempt.json"
    report_path.write_text(
        json.dumps({"sample_quality": {"status": "excluded", "reason_code": "network_failure"}}),
        encoding="utf-8",
    )
    metadata_path = attempt / "metadata.json"
    metadata_path.write_text(
        json.dumps(
            {
                "status": "included",
                "hard_pass": False,
                "soft_score": 0.0,
                "exit_code": 1,
                "paths": {
                    "stdout": str(stdout),
                    "stderr": str(stderr),
                    "runner_result": str(runner),
                    "raw_logs": [str(report_path)],
                },
            }
        ),
        encoding="utf-8",
    )

    assert report.reclassify_run(tmp_path) == 1
    refreshed = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert refreshed["status"] == "excluded"
    assert refreshed["exclusion_reason"] == "network_failure"
    assert refreshed["hard_pass"] is None


def test_report_generates_required_metrics_and_pass_decision(tmp_path: Path):
    report = _load_report_module()
    run_root = tmp_path / "run"
    tasks = [
        "bem-create",
        "equal-width-row",
        "horizontal-layout",
        "line-height",
        "list-spacing",
        "platform-condition",
        "text-truncation",
        "violation-repair",
    ]
    for task in tasks:
        for treatment in ("CONTROL", "DETAIL_LESS_BEM"):
            for rep in range(1, 4):
                hard_pass = treatment == "DETAIL_LESS_BEM" or rep == 1
                _write_attempt(
                    run_root,
                    task,
                    treatment,
                    rep,
                    hard_pass=hard_pass,
                    failed_rules=[] if hard_pass else ["public-less"],
                    soft_score=2.0 if hard_pass else 0.5,
                )

    output_dir = report.generate_report(run_root, timestamp="20260722T010203")
    summary = json.loads((output_dir / "summary.json").read_text(encoding="utf-8"))
    markdown = (output_dir / "summary.md").read_text(encoding="utf-8")

    assert summary["decision"] == "PASS"
    assert summary["overall"]["percentage_point_delta"] >= 20
    assert summary["by_task_treatment"]["line-height"]["DETAIL_LESS_BEM"]["hard_pass_rate"] == 1.0
    assert summary["by_task_treatment"]["bem-create"]["CONTROL"]["failed_rule_counts"] == {
        "public-less": 2
    }
    assert summary["by_task_treatment"]["bem-create"]["CONTROL"]["mean_duration_seconds"] == 10.0
    assert summary["by_task_treatment"]["bem-create"]["CONTROL"]["mean_soft_score"] == 1.0
    assert summary["by_task_treatment"]["bem-create"]["CONTROL"]["raw_log_paths"]
    assert "PASS" in markdown
    assert "included / flagged / excluded" in markdown
    assert "| bem-create | CONTROL |" in markdown
    assert "| line-height | 1.0 | 1.0 | PASS |" in markdown
    assert "| platform-condition | 1.0 | 1.0 | PASS |" in markdown
    assert "| violation-repair | 1.0 | 1.0 | PASS |" in markdown
    assert "| bem-create | CONTROL |" in markdown


def test_report_is_inconclusive_when_attempts_are_excluded(tmp_path: Path):
    report = _load_report_module()
    run_root = tmp_path / "run"
    _write_attempt(
        run_root,
        "line-height",
        "CONTROL",
        1,
        status="excluded",
        hard_pass=None,
    )

    output_dir = report.generate_report(run_root, timestamp="20260722T010204")
    summary = json.loads((output_dir / "summary.json").read_text(encoding="utf-8"))
    markdown = (output_dir / "summary.md").read_text(encoding="utf-8")

    assert summary["decision"] == "INCONCLUSIVE"
    assert summary["classification_counts"] == {"included": 0, "flagged": 0, "excluded": 1}
    assert "| line-height | n/a | 1.0 | INCONCLUSIVE |" in markdown


def test_dry_run_records_all_48_excluded_attempts(tmp_path: Path):
    reports_root = tmp_path / "reports"
    result = subprocess.run(
        [
            "bash",
            str(RUN_MATRIX_PATH),
            "--dry-run",
            "--evidence-root",
            str(tmp_path / "evidence"),
            "--reports-root",
            str(reports_root),
        ],
        cwd=EVAL_ROOT,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    run_dirs = [path for path in (tmp_path / "evidence").iterdir() if path.is_dir()]
    assert len(run_dirs) == 1
    metadata_files = list(run_dirs[0].glob("attempts/*/*/rep-*/metadata.json"))
    assert len(metadata_files) == 48
    assert {json.loads(path.read_text())["status"] for path in metadata_files} == {"excluded"}
    assert {json.loads(path.read_text())["exclusion_reason"] for path in metadata_files} == {
        "dry_run"
    }
    assert len(list(reports_root.glob("*/summary.json"))) == 1


def test_failed_docker_preflight_records_all_48_excluded_attempts(tmp_path: Path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    docker = fake_bin / "docker"
    docker.write_text("#!/usr/bin/env bash\nexit 1\n", encoding="utf-8")
    docker.chmod(0o755)
    evidence_root = tmp_path / "evidence"
    reports_root = tmp_path / "reports"
    env = os.environ.copy()
    env["PATH"] = f"{fake_bin}:{env['PATH']}"

    result = subprocess.run(
        [
            "bash",
            str(RUN_MATRIX_PATH),
            "--evidence-root",
            str(evidence_root),
            "--reports-root",
            str(reports_root),
        ],
        cwd=EVAL_ROOT,
        env=env,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    metadata_files = list(evidence_root.glob("*/attempts/*/*/rep-*/metadata.json"))
    assert len(metadata_files) == 48
    assert {json.loads(path.read_text())["status"] for path in metadata_files} == {"excluded"}
    assert {json.loads(path.read_text())["exclusion_reason"] for path in metadata_files} == {
        "docker_unavailable"
    }
    for metadata_path in metadata_files:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        assert "docker_unavailable" in Path(metadata["paths"]["stderr"]).read_text(encoding="utf-8")
        assert metadata["paths"]["raw_logs"] == [
            metadata["paths"]["stdout"],
            metadata["paths"]["stderr"],
            metadata["paths"]["pytest_log"],
        ]


def test_matrix_runner_failure_is_flagged_not_excluded(tmp_path: Path):
    report = _load_report_module()

    attempt_dir = report.record_flagged_attempt(
        tmp_path,
        "line-height",
        "CONTROL",
        1,
        "direct",
        "matrix_runner_failure",
        {},
    )
    metadata = json.loads((attempt_dir / "metadata.json").read_text(encoding="utf-8"))

    assert metadata["status"] == "flagged"
    assert metadata["flag_reason"] == "matrix_runner_failure"
    assert "exclusion_reason" not in metadata
