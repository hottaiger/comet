#!/usr/bin/env python3
"""Run-evidence helpers and aggregate report for the detail-less-bem matrix."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tomllib
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean
from typing import Any


BENCH_ROOT = Path(__file__).resolve().parent
EVAL_ROOT = BENCH_ROOT.parent
TASKS_DIR = BENCH_ROOT / "local" / "tasks"
TREATMENTS_DIR = BENCH_ROOT / "local" / "treatments"
TREATMENT_NAMES = ("CONTROL", "DETAIL_LESS_BEM")
REPETITIONS = 3
EXPECTED_ATTEMPTS = 48
CRITICAL_TASKS = ("line-height", "platform-condition", "violation-repair")
UPLIFT_THRESHOLD_POINTS = 20.0


def _read_toml(path: Path) -> dict[str, Any]:
    with path.open("rb") as stream:
        return tomllib.load(stream)


def execution_fingerprint(treatment_path: Path) -> str:
    """Return a stable representation of all non-treatment execution controls."""
    execution = _read_toml(treatment_path).get("execution") or {}
    return json.dumps(execution, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def build_matrix_plan(bench_root: Path = BENCH_ROOT) -> list[dict[str, Any]]:
    """Build 8 tasks x 2 treatments x 3 deterministic repetitions."""
    tasks_dir = bench_root / "local" / "tasks"
    treatments_dir = bench_root / "local" / "treatments"
    fingerprints = {
        name: execution_fingerprint(treatments_dir / f"{name}.toml") for name in TREATMENT_NAMES
    }
    if len(set(fingerprints.values())) != 1:
        raise ValueError("Treatment execution settings differ; DETAIL must be the only variable")

    plan: list[dict[str, Any]] = []
    task_paths = sorted(path for path in tasks_dir.iterdir() if (path / "task.toml").exists())
    for task_path in task_paths:
        task_config = _read_toml(task_path / "task.toml")
        metadata = task_config.get("metadata") or {}
        variants = list(metadata.get("instruction_variants") or [])
        if len(variants) != REPETITIONS or len(set(variants)) != REPETITIONS:
            raise ValueError(
                f"{task_path.name} must declare exactly three unique instruction variants"
            )
        for treatment in TREATMENT_NAMES:
            execution = _read_toml(treatments_dir / f"{treatment}.toml").get("execution") or {}
            for rep, variant in enumerate(variants, start=1):
                plan.append(
                    {
                        "task": task_path.name,
                        "treatment": treatment,
                        "rep": rep,
                        "variant": variant,
                        "execution": execution,
                    }
                )
    if len(plan) != EXPECTED_ATTEMPTS:
        raise ValueError(f"Expected {EXPECTED_ATTEMPTS} attempts, planned {len(plan)}")
    return plan


def classify_attempt(
    returncode: int,
    stdout: str,
    stderr: str,
    runner_result: dict[str, Any] | None,
    sample_quality: dict[str, Any] | None = None,
) -> dict[str, str]:
    """Classify a trial without converting infrastructure failures into task failures."""
    if sample_quality and sample_quality.get("status") in {"excluded", "flagged"}:
        reason = str(sample_quality.get("reason_code") or "infrastructure_failure")
        return {"status": str(sample_quality["status"]), "reason": reason}
    combined = f"{stdout}\n{stderr}".lower()
    runner_startup_patterns = (
        "cannot find module '/workspace/claude'",
        'cannot find module "/workspace/claude"',
        "claude: command not found",
        "claude code cli not available",
    )
    if any(pattern in combined for pattern in runner_startup_patterns):
        return {"status": "flagged", "reason": "agent_runner_startup_failure"}
    infrastructure_patterns = (
        (
            "docker_unavailable",
            ("docker not available", "cannot connect to the docker daemon", "docker daemon"),
        ),
        (
            "authentication_failure",
            (
                "authentication failed",
                "not authenticated",
                "invalid api key",
                "unauthorized",
                "http 401",
                "status 401",
                "error 401",
                "anthropic_api_key or anthropic_auth_token not set",
            ),
        ),
        (
            "network_failure",
            (
                "connection timed out",
                "network is unreachable",
                "connection refused",
                "dns",
                "name resolution",
            ),
        ),
        (
            "outer_timeout",
            ("outer timeout", "timeout after", "timed out", "timed out after"),
        ),
    )
    for reason, patterns in infrastructure_patterns:
        if any(pattern in combined for pattern in patterns):
            return {"status": "excluded", "reason": reason}
    if runner_result is not None:
        return {"status": "included"}
    return {"status": "flagged", "reason": "runner_failure"}


def _attempt_dir(run_root: Path, task: str, treatment: str, rep: int) -> Path:
    return run_root / "attempts" / task / treatment / f"rep-{rep}"


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _ensure_attempt_files(attempt_dir: Path) -> dict[str, Any]:
    attempt_dir.mkdir(parents=True, exist_ok=True)
    files = {
        "stdout": attempt_dir / "stdout.log",
        "stderr": attempt_dir / "stderr.log",
        "pytest_log": attempt_dir / "pytest.log",
        "diff": attempt_dir / "diff.patch",
        "agent_trajectory": attempt_dir / "agent_trajectory.jsonl",
        "test_results": attempt_dir / "_test_results.json",
        "runner_result": attempt_dir / "runner_result.json",
    }
    for key in ("stdout", "stderr", "pytest_log", "diff", "agent_trajectory"):
        files[key].touch(exist_ok=True)
    for key in ("test_results", "runner_result"):
        if not files[key].exists():
            _write_json(files[key], {})
    paths = {key: str(path.resolve()) for key, path in files.items()}
    paths["raw_logs"] = [paths["stdout"], paths["stderr"], paths["pytest_log"]]
    return paths


def _record_nonincluded_attempt(
    run_root: Path,
    task: str,
    treatment: str,
    rep: int,
    variant: str,
    reason: str,
    status: str,
    execution: dict[str, Any] | None = None,
) -> Path:
    attempt_dir = _attempt_dir(run_root, task, treatment, rep)
    paths = _ensure_attempt_files(attempt_dir)
    message = f"Attempt {status} before execution: {reason}\n"
    output_key = "stdout" if reason == "dry_run" else "stderr"
    Path(paths[output_key]).write_text(message, encoding="utf-8")
    Path(paths["pytest_log"]).write_text(message, encoding="utf-8")
    now = datetime.now(timezone.utc).isoformat()
    metadata = {
        "schema_version": 1,
        "attempt_id": f"{task}__{treatment}__rep-{rep}",
        "task": task,
        "treatment": treatment,
        "rep": rep,
        "variant": variant,
        "status": status,
        "hard_pass": None,
        "failed_rules": [],
        "soft_score": None,
        "started_at": now,
        "completed_at": now,
        "duration_seconds": 0.0,
        "execution": execution or {},
        "paths": paths,
        "exclusion_reason" if status == "excluded" else "flag_reason": reason,
    }
    _write_json(attempt_dir / "metadata.json", metadata)
    return attempt_dir


def record_excluded_attempt(
    run_root: Path,
    task: str,
    treatment: str,
    rep: int,
    variant: str,
    reason: str,
    execution: dict[str, Any] | None = None,
) -> Path:
    return _record_nonincluded_attempt(
        run_root, task, treatment, rep, variant, reason, "excluded", execution
    )


def record_flagged_attempt(
    run_root: Path,
    task: str,
    treatment: str,
    rep: int,
    variant: str,
    reason: str,
    execution: dict[str, Any] | None = None,
) -> Path:
    return _record_nonincluded_attempt(
        run_root, task, treatment, rep, variant, reason, "flagged", execution
    )


def _load_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def _failed_rule(check: str) -> str:
    cleaned = re.sub(r"^\[(?:HARD|RUBRIC)\]\s*", "", str(check)).strip()
    return cleaned.split(":", 1)[0].strip() or "unknown"


def _soft_score(runner_result: dict[str, Any] | None) -> float | None:
    if not runner_result:
        return None
    for check in runner_result.get("passed") or []:
        match = re.search(r"\[RUBRIC\]\s+weighted_score:\s*([0-9.]+)", str(check))
        if match:
            return float(match.group(1))
    return None


def _experiment_log_paths(stdout: str) -> list[str]:
    paths: list[str] = []
    for match in re.finditer(r"Logging to:\s*(.+)", stdout):
        raw = Path(match.group(1).strip())
        if raw.exists():
            paths.extend(str(path.resolve()) for path in sorted(raw.rglob("*")) if path.is_file())
        else:
            paths.append(str(raw))
    return paths


def _sample_quality_from_raw_paths(raw_paths: list[str]) -> dict[str, Any] | None:
    """Read the scaffold's authoritative infrastructure classification, when present."""
    for raw_path in raw_paths:
        path = Path(raw_path)
        if path.parent.name != "reports" or path.suffix != ".json":
            continue
        payload = _load_json(path)
        sample_quality = (payload or {}).get("sample_quality")
        if isinstance(sample_quality, dict):
            return sample_quality
    return None


def execute_attempt(
    run_root: Path,
    task: str,
    treatment: str,
    rep: int,
    variant: str,
    outer_timeout: int,
    bench_root: Path = BENCH_ROOT,
) -> Path:
    """Run one isolated pytest attempt and persist evidence even when it fails."""
    attempt_dir = _attempt_dir(run_root, task, treatment, rep)
    paths = _ensure_attempt_files(attempt_dir)
    treatment_config = _read_toml(bench_root / "local" / "treatments" / f"{treatment}.toml")
    execution = treatment_config.get("execution") or {}
    started = datetime.now(timezone.utc)
    pytest_bin = EVAL_ROOT / ".venv" / "bin" / "pytest"
    command = [
        str(pytest_bin),
        "local/tests/tasks/test_tasks.py::test_task_treatment",
        f"--task={task}",
        f"--treatment={treatment}",
        "--count=1",
        "--interaction-mode=none",
        "-rs",
        "-q",
    ]
    env = os.environ.copy()
    env.update(
        {
            "BENCH_SUITE_ROOT": str((bench_root / "local").resolve()),
            "BENCH_TASKS_DIR": str((bench_root / "local" / "tasks").resolve()),
            "BENCH_TREATMENTS_DIR": str((bench_root / "local" / "treatments").resolve()),
            "BENCH_TASK_VARIANT": variant,
            "BENCH_REP_INDEX": str(rep),
            "BENCH_ATTEMPT_EVIDENCE_DIR": str(attempt_dir.resolve()),
            "TRACE_TO_LANGSMITH": "false",
        }
    )
    for key in list(env):
        if key.startswith("LANGSMITH_") or key.startswith("CC_LANGSMITH_"):
            env.pop(key, None)

    timed_out = False
    try:
        completed = subprocess.run(
            command,
            cwd=EVAL_ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=outer_timeout,
            check=False,
        )
        returncode, stdout, stderr = completed.returncode, completed.stdout, completed.stderr
    except subprocess.TimeoutExpired as error:
        timed_out = True
        returncode = 124
        stdout = error.stdout.decode() if isinstance(error.stdout, bytes) else (error.stdout or "")
        stderr = error.stderr.decode() if isinstance(error.stderr, bytes) else (error.stderr or "")
        stderr += f"\nOuter timeout after {outer_timeout}s"

    Path(paths["stdout"]).write_text(stdout, encoding="utf-8")
    Path(paths["stderr"]).write_text(stderr, encoding="utf-8")
    Path(paths["pytest_log"]).write_text(
        stdout + ("\n" if stdout and stderr else "") + stderr, encoding="utf-8"
    )
    runner_result = _load_json(Path(paths["runner_result"]))
    if runner_result == {}:
        runner_result = None
    raw_paths = _experiment_log_paths(stdout)
    sample_quality = _sample_quality_from_raw_paths(raw_paths)
    classification = (
        {"status": "excluded", "reason": "outer_timeout"}
        if timed_out
        else classify_attempt(returncode, stdout, stderr, runner_result, sample_quality)
    )
    failed = list((runner_result or {}).get("failed") or [])
    paths["raw_logs"] = list(dict.fromkeys(paths["raw_logs"] + raw_paths))
    completed_at = datetime.now(timezone.utc)
    metadata = {
        "schema_version": 1,
        "attempt_id": f"{task}__{treatment}__rep-{rep}",
        "task": task,
        "treatment": treatment,
        "rep": rep,
        "variant": variant,
        "status": classification["status"],
        "hard_pass": not failed if runner_result is not None else None,
        "failed_rules": [_failed_rule(check) for check in failed],
        "soft_score": _soft_score(runner_result),
        "started_at": started.isoformat(),
        "completed_at": completed_at.isoformat(),
        "duration_seconds": round((completed_at - started).total_seconds(), 3),
        "exit_code": returncode,
        "command": command,
        "execution": execution,
        "sample_quality": sample_quality,
        "paths": paths,
    }
    if classification.get("reason"):
        key = "exclusion_reason" if classification["status"] == "excluded" else "flag_reason"
        metadata[key] = classification["reason"]
    _write_json(attempt_dir / "metadata.json", metadata)
    return attempt_dir


def _attempts(run_root: Path) -> list[dict[str, Any]]:
    attempts: list[dict[str, Any]] = []
    for path in sorted((run_root / "attempts").glob("*/*/rep-*/metadata.json")):
        payload = _load_json(path)
        if payload:
            payload["metadata_path"] = str(path.resolve())
            attempts.append(payload)
    return attempts


def reclassify_run(run_root: Path) -> int:
    """Refresh attempt classifications from scaffold sample-quality reports."""
    changed = 0
    for metadata_path in sorted((run_root / "attempts").glob("*/*/rep-*/metadata.json")):
        metadata = _load_json(metadata_path)
        if not metadata:
            continue
        paths = metadata.get("paths") or {}
        stdout_path = Path(str(paths.get("stdout", "")))
        stderr_path = Path(str(paths.get("stderr", "")))
        stdout = stdout_path.read_text(encoding="utf-8") if stdout_path.exists() else ""
        stderr = stderr_path.read_text(encoding="utf-8") if stderr_path.exists() else ""
        runner_result = _load_json(Path(str(paths.get("runner_result", ""))))
        if runner_result == {}:
            runner_result = None
        sample_quality = _sample_quality_from_raw_paths(
            [str(path) for path in (paths.get("raw_logs") or [])]
        )
        classification = classify_attempt(
            int(metadata.get("exit_code", 1)), stdout, stderr, runner_result, sample_quality
        )
        if classification["status"] == metadata.get("status"):
            continue
        metadata["status"] = classification["status"]
        metadata["sample_quality"] = sample_quality
        if classification["status"] == "excluded":
            metadata["hard_pass"] = None
            metadata["soft_score"] = None
            metadata["exclusion_reason"] = classification["reason"]
            metadata.pop("flag_reason", None)
        elif classification.get("reason"):
            metadata["flag_reason"] = classification["reason"]
            metadata.pop("exclusion_reason", None)
        _write_json(metadata_path, metadata)
        changed += 1
    return changed


def _group_summary(attempts: list[dict[str, Any]]) -> dict[str, Any]:
    included = [attempt for attempt in attempts if attempt.get("status") == "included"]
    hard_values = [bool(attempt.get("hard_pass")) for attempt in included]
    durations = [
        float(attempt["duration_seconds"])
        for attempt in included
        if attempt.get("duration_seconds") is not None
    ]
    soft_scores = [
        float(attempt["soft_score"])
        for attempt in included
        if attempt.get("soft_score") is not None
    ]
    failed_rules = Counter(
        rule for attempt in included for rule in (attempt.get("failed_rules") or [])
    )
    raw_log_paths: list[str] = []
    for attempt in attempts:
        paths = attempt.get("paths") or {}
        for key in ("stdout", "stderr", "pytest_log"):
            if paths.get(key):
                raw_log_paths.append(str(paths[key]))
        raw_log_paths.extend(str(path) for path in (paths.get("raw_logs") or []))
    counts = Counter(str(attempt.get("status", "flagged")) for attempt in attempts)
    return {
        "attempts": len(attempts),
        "included": counts["included"],
        "flagged": counts["flagged"],
        "excluded": counts["excluded"],
        "hard_passes": sum(hard_values),
        "hard_pass_rate": round(sum(hard_values) / len(hard_values), 4) if hard_values else None,
        "mean_duration_seconds": round(mean(durations), 3) if durations else None,
        "failed_rule_counts": dict(sorted(failed_rules.items())),
        "mean_soft_score": round(mean(soft_scores), 3) if soft_scores else None,
        "raw_log_paths": list(dict.fromkeys(raw_log_paths)),
    }


def _decision(summary: dict[str, Any], attempts: list[dict[str, Any]]) -> tuple[str, list[str]]:
    reasons: list[str] = []
    counts = summary["classification_counts"]
    if len(attempts) != EXPECTED_ATTEMPTS or counts["flagged"] or counts["excluded"]:
        reasons.append("The 48-attempt matrix is incomplete or contains flagged/excluded attempts.")
        return "INCONCLUSIVE", reasons
    overall = summary["overall"]
    if overall["percentage_point_delta"] is None:
        return "INCONCLUSIVE", ["Both treatments need included hard-pass observations."]
    if overall["percentage_point_delta"] < UPLIFT_THRESHOLD_POINTS:
        reasons.append(
            f"Hard-pass uplift is below {UPLIFT_THRESHOLD_POINTS:.0f} percentage points."
        )
    for task in CRITICAL_TASKS:
        rate = (
            summary["by_task_treatment"]
            .get(task, {})
            .get("DETAIL_LESS_BEM", {})
            .get("hard_pass_rate")
        )
        if rate != 1.0:
            reasons.append(f"DETAIL_LESS_BEM must reach 100% hard pass on {task}.")
    return ("FAIL", reasons) if reasons else ("PASS", ["All decision thresholds passed."])


def generate_report(
    run_root: Path,
    *,
    timestamp: str | None = None,
    output_root: Path | None = None,
) -> Path:
    attempts = _attempts(run_root)
    classification_counts = Counter(str(attempt.get("status", "flagged")) for attempt in attempts)
    by_task: dict[str, dict[str, Any]] = {}
    for task in sorted({str(attempt["task"]) for attempt in attempts}):
        by_task[task] = {}
        for treatment in TREATMENT_NAMES:
            group = [
                attempt
                for attempt in attempts
                if attempt.get("task") == task and attempt.get("treatment") == treatment
            ]
            by_task[task][treatment] = _group_summary(group)
    treatment_groups = {
        treatment: _group_summary(
            [attempt for attempt in attempts if attempt.get("treatment") == treatment]
        )
        for treatment in TREATMENT_NAMES
    }
    control_rate = treatment_groups["CONTROL"]["hard_pass_rate"]
    detail_rate = treatment_groups["DETAIL_LESS_BEM"]["hard_pass_rate"]
    delta = (
        round((detail_rate - control_rate) * 100, 2)
        if control_rate is not None and detail_rate is not None
        else None
    )
    summary: dict[str, Any] = {
        "schema_version": 1,
        "run_root": str(run_root.resolve()),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "expected_attempts": EXPECTED_ATTEMPTS,
        "observed_attempts": len(attempts),
        "classification_counts": {
            "included": classification_counts["included"],
            "flagged": classification_counts["flagged"],
            "excluded": classification_counts["excluded"],
        },
        "overall": {
            "CONTROL": treatment_groups["CONTROL"],
            "DETAIL_LESS_BEM": treatment_groups["DETAIL_LESS_BEM"],
            "percentage_point_delta": delta,
        },
        "by_task_treatment": by_task,
        "thresholds": {
            "minimum_percentage_point_delta": UPLIFT_THRESHOLD_POINTS,
            "critical_tasks": list(CRITICAL_TASKS),
            "critical_task_detail_hard_pass_rate": 1.0,
        },
        "attempts": attempts,
    }
    summary["decision"], summary["decision_reasons"] = _decision(summary, attempts)

    stamp = timestamp or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output_dir = (output_root or (run_root / "reports")) / stamp
    output_dir.mkdir(parents=True, exist_ok=True)
    _write_json(output_dir / "summary.json", summary)

    lines = [
        "# detail-less-bem evaluation report",
        "",
        f"Decision: **{summary['decision']}**",
        "",
        "Classification: included / flagged / excluded = "
        f"{classification_counts['included']} / {classification_counts['flagged']} / {classification_counts['excluded']}",
        "",
        f"Hard-pass uplift: {delta if delta is not None else 'n/a'} percentage points "
        f"(threshold: {UPLIFT_THRESHOLD_POINTS:.0f}).",
        "",
        "| Task | Treatment | Included | Flagged | Excluded | Hard pass rate | Mean duration (s) | Soft score | Failed rules | Raw logs |",
        "|---|---|---:|---:|---:|---:|---:|---:|---|---|",
    ]
    for task, treatments in by_task.items():
        for treatment, metrics in treatments.items():
            rate = metrics["hard_pass_rate"]
            raw_logs = "<br>".join(metrics["raw_log_paths"])
            lines.append(
                f"| {task} | {treatment} | {metrics['included']} | {metrics['flagged']} | "
                f"{metrics['excluded']} | {rate if rate is not None else 'n/a'} | "
                f"{metrics['mean_duration_seconds'] if metrics['mean_duration_seconds'] is not None else 'n/a'} | "
                f"{metrics['mean_soft_score'] if metrics['mean_soft_score'] is not None else 'n/a'} | "
                f"{json.dumps(metrics['failed_rule_counts'], ensure_ascii=False)} | "
                f"{raw_logs} |"
            )
    lines.extend(
        [
            "",
            "## Critical task thresholds",
            "",
            "DETAIL_LESS_BEM must reach a 100% hard-pass rate on each critical task.",
            "",
            "| Task | Actual | Required | Status |",
            "|---|---:|---:|---|",
        ]
    )
    for task in CRITICAL_TASKS:
        rate = by_task.get(task, {}).get("DETAIL_LESS_BEM", {}).get("hard_pass_rate")
        status = "INCONCLUSIVE" if rate is None else ("PASS" if rate == 1.0 else "FAIL")
        lines.append(f"| {task} | {rate if rate is not None else 'n/a'} | 1.0 | {status} |")
    lines.extend(["", "## Decision reasons", ""])
    lines.extend(f"- {reason}" for reason in summary["decision_reasons"])
    (output_dir / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return output_dir


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    plan = subparsers.add_parser("plan")
    plan.add_argument("--bench-root", type=Path, default=BENCH_ROOT)
    excluded = subparsers.add_parser("record-excluded")
    flagged = subparsers.add_parser("record-flagged")
    execute = subparsers.add_parser("execute-attempt")
    for subparser in (excluded, flagged, execute):
        subparser.add_argument("--run-root", type=Path, required=True)
        subparser.add_argument("--task", required=True)
        subparser.add_argument("--treatment", required=True)
        subparser.add_argument("--rep", type=int, required=True)
        subparser.add_argument("--variant", required=True)
        subparser.add_argument("--bench-root", type=Path, default=BENCH_ROOT)
    excluded.add_argument("--reason", required=True)
    flagged.add_argument("--reason", required=True)
    execute.add_argument("--outer-timeout", type=int, default=900)
    summarize = subparsers.add_parser("summarize")
    summarize.add_argument("run_root", type=Path)
    summarize.add_argument("--output-root", type=Path)
    summarize.add_argument("--timestamp")
    reclassify = subparsers.add_parser("reclassify-run")
    reclassify.add_argument("run_root", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "plan":
        for item in build_matrix_plan(args.bench_root):
            print(f"{item['task']}\t{item['treatment']}\t{item['rep']}\t{item['variant']}")
        return 0
    if args.command == "record-excluded":
        treatment_path = args.bench_root / "local" / "treatments" / f"{args.treatment}.toml"
        execution = _read_toml(treatment_path).get("execution") or {}
        record_excluded_attempt(
            args.run_root,
            args.task,
            args.treatment,
            args.rep,
            args.variant,
            args.reason,
            execution,
        )
        return 0
    if args.command == "record-flagged":
        treatment_path = args.bench_root / "local" / "treatments" / f"{args.treatment}.toml"
        execution = _read_toml(treatment_path).get("execution") or {}
        record_flagged_attempt(
            args.run_root,
            args.task,
            args.treatment,
            args.rep,
            args.variant,
            args.reason,
            execution,
        )
        return 0
    if args.command == "execute-attempt":
        execute_attempt(
            args.run_root,
            args.task,
            args.treatment,
            args.rep,
            args.variant,
            args.outer_timeout,
            args.bench_root,
        )
        return 0
    if args.command == "reclassify-run":
        print(reclassify_run(args.run_root))
        return 0
    output_dir = generate_report(
        args.run_root,
        timestamp=args.timestamp,
        output_root=args.output_root,
    )
    print(output_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
