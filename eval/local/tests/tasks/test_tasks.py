"""Generic test runner for comet skill task + treatment combinations.

Usage:
    # Run all default task/treatment combinations
    pytest local/tests/tasks/test_tasks.py -v

    # Run specific task with specific treatment
    pytest local/tests/tasks/test_tasks.py --task=comet-full-workflow --treatment=COMET_FULL_040_BETA -v

    # Run specific task with multiple treatments (comma-separated)
    pytest local/tests/tasks/test_tasks.py --task=comet-full-workflow --treatment=COMET_FULL_040_BETA,CONTROL -v

    # Run with repetitions and parallel workers
    pytest local/tests/tasks/test_tasks.py --task=comet-full-workflow --treatment=COMET_FULL_040_BETA --count=2 -n 2 -v
"""

import difflib
import json
import os
import sys
import uuid
from pathlib import Path

import pytest
import conftest
from conftest import get_fixtures

from scaffold import Treatment
from scaffold.python import extract_events, parse_output
from scaffold.python.profiles import resolve_profile_name, run_profile_rubric
from scaffold.python.tasks import list_tasks, load_task
from scaffold.python.treatments import TreatmentConfig, build_treatment_skills, load_treatments
from scaffold.python.validation import run_validators

# Timeouts
CLAUDE_TIMEOUT = 1500  # 25 minutes for Claude to complete task (multi-turn loop)
PYTEST_TIMEOUT = 1800  # 30 minutes total including setup/teardown
MANIFEST_DYNAMIC_ONLY_TASKS = {"workflow-overlay-contract"}
CONTROL_BUSINESS_ONLY_TREATMENTS = {"CONTROL"}
COMET_WORKFLOW_ONLY_CHECK_PREFIXES = (
    "openspec_artifacts",
    "comet_state",
    "workflow_phases",
    "tests_written",
    "tests_exist",
)


# =============================================================================
# PARAMETRIZE HELPERS
# =============================================================================


def expand_treatment_patterns(patterns: list[str], all_treatments: dict) -> list[str]:
    """Expand treatment patterns into matching treatment names."""
    treatment_names = list(all_treatments.keys())
    expanded = []

    for pattern in patterns:
        if pattern.endswith("*"):
            prefix = pattern[:-1]
            matches = [t for t in treatment_names if t.startswith(prefix)]
            if not matches:
                raise ValueError(
                    f"No treatments match pattern: {pattern}. Available: {treatment_names}"
                )
            expanded.extend(matches)
        else:
            if pattern not in all_treatments:
                raise ValueError(f"Treatment not found: {pattern}. Available: {treatment_names}")
            expanded.append(pattern)

    return list(dict.fromkeys(expanded))


def generate_test_params(task_filter: str | None, treatment_filter: str | None, config=None):
    """Generate (task_name, treatment_name) pairs based on filters."""
    params = []
    all_treatments = load_treatments()
    all_tasks = list_tasks()
    dynamic = None

    if config is not None:
        dynamic = conftest._get_dynamic_treatment_config(config)
        if dynamic:
            all_treatments[dynamic.name] = dynamic
    manifest_tasks = None
    manifest_baseline_treatments = []
    if config is not None and config.getoption("--eval-manifest"):
        from scaffold.python.manifests import load_eval_manifest

        manifest = load_eval_manifest(config.getoption("--eval-manifest"))
        manifest_tasks = manifest.recommended_tasks
        manifest_baseline_treatments = manifest.baseline_treatments

    if task_filter and task_filter not in all_tasks:
        raise ValueError(f"Task not found: {task_filter}. Available: {all_tasks}")

    treatment_list = []
    if treatment_filter:
        patterns = [t.strip() for t in treatment_filter.split(",")]
        treatment_list = expand_treatment_patterns(patterns, all_treatments)
    elif dynamic and manifest_tasks:
        treatment_list = [
            treatment for treatment in manifest_baseline_treatments if treatment in all_treatments
        ]
        if dynamic.name not in treatment_list:
            treatment_list.append(dynamic.name)
    elif dynamic:
        treatment_list = [dynamic.name]

    tasks_to_run = [task_filter] if task_filter else (manifest_tasks or all_tasks)

    for task_name in tasks_to_run:
        task = load_task(task_name)
        task_treatments = treatment_list
        if (
            dynamic
            and manifest_tasks
            and not treatment_filter
            and task_name in MANIFEST_DYNAMIC_ONLY_TASKS
        ):
            task_treatments = [dynamic.name]
        if task_treatments:
            for treatment_name in task_treatments:
                params.append((task_name, treatment_name))
        else:
            for treatment_name in task.default_treatments:
                if treatment_name in all_treatments:
                    params.append((task_name, treatment_name))

    return params


def _is_control_business_only_run(profile_name: str, treatment_name: str) -> bool:
    return profile_name == "comet-workflow" and treatment_name in CONTROL_BUSINESS_ONLY_TREATMENTS


def _filter_control_workflow_checks(
    profile_name: str,
    treatment_name: str,
    passed: list[str],
    failed: list[str],
) -> tuple[list[str], list[str]]:
    """For CONTROL, evaluate comet tasks by business outcome only.

    CONTROL intentionally has no Skill mounted. OpenSpec/Comet state, phase
    evidence, and workflow-test discipline are reported by the rubric as
    non-applicable instead of counted as task failures.
    """
    if not _is_control_business_only_run(profile_name, treatment_name):
        return passed, failed

    def keep(check: str) -> bool:
        return not any(check.startswith(prefix) for prefix in COMET_WORKFLOW_ONLY_CHECK_PREFIXES)

    return [check for check in passed if keep(check)], [check for check in failed if keep(check)]


def _split_comet_completion_checks(
    passed: list[str],
    failed: list[str],
) -> dict[str, dict[str, list[str]]]:
    """Split validator results into business and workflow completion buckets."""

    def is_workflow_check(check: str) -> bool:
        return any(check.startswith(prefix) for prefix in COMET_WORKFLOW_ONLY_CHECK_PREFIXES)

    return {
        "business_completion": {
            "passed": [check for check in passed if not is_workflow_check(check)],
            "failed": [check for check in failed if not is_workflow_check(check)],
        },
        "workflow_completion": {
            "passed": [check for check in passed if is_workflow_check(check)],
            "failed": [check for check in failed if is_workflow_check(check)],
        },
    }


def test_eval_manifest_baselines_extend_dynamic_treatment_list(tmp_path, monkeypatch):
    package = tmp_path / "manifest-skill"
    package.mkdir()
    (package / "SKILL.md").write_text("---\nname: manifest-skill\n---\n\nBody.", encoding="utf-8")
    comet_dir = package / "comet"
    comet_dir.mkdir()
    manifest = comet_dir / "eval.yaml"
    manifest.write_text(
        """
apiVersion: comet.eval/v1alpha1
kind: SkillEvalManifest
metadata:
  name: manifest-skill
skill:
  name: manifest-skill
  source: ..
evaluation:
  recommendedTasks:
    - generic-skill-smoke
    - workflow-overlay-contract
  baselineTreatments:
    - CONTROL
    - COMET_FULL_040_BETA
    - MISSING_BASELINE
interaction:
  mode: none
""",
        encoding="utf-8",
    )

    class Config:
        def getoption(self, name):
            return {"--eval-manifest": str(manifest)}.get(name)

    monkeypatch.setattr(
        sys.modules[__name__],
        "load_treatments",
        lambda: {
            "CONTROL": TreatmentConfig(name="CONTROL", description="Control"),
            "COMET_FULL_040_BETA": TreatmentConfig(
                name="COMET_FULL_040_BETA", description="Comet full"
            ),
        },
    )

    params = generate_test_params("generic-skill-smoke", None, Config())

    assert params == [
        ("generic-skill-smoke", "CONTROL"),
        ("generic-skill-smoke", "COMET_FULL_040_BETA"),
        ("generic-skill-smoke", "DYNAMIC_SKILL"),
    ]

    assert generate_test_params("workflow-overlay-contract", None, Config()) == [
        ("workflow-overlay-contract", "DYNAMIC_SKILL")
    ]
    assert generate_test_params(None, None, Config()) == [
        ("generic-skill-smoke", "CONTROL"),
        ("generic-skill-smoke", "COMET_FULL_040_BETA"),
        ("generic-skill-smoke", "DYNAMIC_SKILL"),
        ("workflow-overlay-contract", "DYNAMIC_SKILL"),
    ]


def test_control_comet_workflow_filters_workflow_only_checks():
    passed, failed = _filter_control_workflow_checks(
        "comet-workflow",
        "CONTROL",
        ["sentence_feature", "tests_written: ok", "workflow_phases: 5/5", "tests_exist"],
        [
            "openspec_artifacts: openspec/changes/ directory not found",
            "comet_state: No .comet.yaml found",
            "workflow_phases: Only 1/5 phases",
            "tests_written: No test files written by the agent",
            "tests_exist: No test files found",
            "sentence_feature: --sentences flag not found",
        ],
    )

    assert passed == ["sentence_feature"]
    assert failed == ["sentence_feature: --sentences flag not found"]


def test_split_comet_completion_checks_separates_business_and_workflow():
    completion = _split_comet_completion_checks(
        ["sentence_feature", "tests_exist", "workflow_phases: 5/5"],
        [
            "openspec_artifacts: missing",
            "comet_state: missing",
            "business_rule: failed",
        ],
    )

    assert completion["business_completion"] == {
        "passed": ["sentence_feature"],
        "failed": ["business_rule: failed"],
    }
    assert completion["workflow_completion"] == {
        "passed": ["tests_exist", "workflow_phases: 5/5"],
        "failed": ["openspec_artifacts: missing", "comet_state: missing"],
    }


def test_control_filter_does_not_apply_to_comet_treatment():
    passed, failed = _filter_control_workflow_checks(
        "comet-workflow",
        "COMET_FULL_040_BETA",
        [],
        ["openspec_artifacts: missing"],
    )

    assert passed == []
    assert failed == ["openspec_artifacts: missing"]


def pytest_generate_tests(metafunc):
    """Dynamically parametrize tests based on CLI options.

    ``--count N`` repeats each (task, treatment) pair N times so the report can
    compute pass-rate distributions instead of a single noisy sample.
    """
    required_fixtures = {"task_name", "treatment_name", "rep_index", "task_variant"}
    if required_fixtures.issubset(metafunc.fixturenames):
        task_filter = metafunc.config.getoption("--task")
        treatment_filter = metafunc.config.getoption("--treatment")
        count = int(metafunc.config.getoption("--count") or 1)
        base_params = generate_test_params(task_filter, treatment_filter, metafunc.config)
        # pytest ids stay (task, treatment); the rep number is tracked separately
        # by the experiment plugin's get_rep_number per treatment. To force N
        # distinct test invocations we append a rep suffix to the param id.
        params = []
        for rep in range(count):
            for task_name, treatment_name in base_params:
                task = load_task(task_name)
                variants = task.config.instruction_variants
                variant_override = os.environ.get("BENCH_TASK_VARIANT")
                variant = variant_override or (variants[rep % len(variants)] if variants else None)
                rep_index = int(os.environ.get("BENCH_REP_INDEX", rep + 1))
                params.append(
                    pytest.param(
                        task_name,
                        treatment_name,
                        rep_index,
                        variant,
                        id=f"{task_name}-{treatment_name}-r{rep_index}",
                    )
                )
        metafunc.parametrize("task_name,treatment_name,rep_index,task_variant", params)


# =============================================================================
# TEST
# =============================================================================


def _execution_contract(treatments, treatment_names: list[str]) -> dict:
    """Ensure execution controls are identical across the compared treatments."""
    contracts = {name: dict(treatments[name].execution or {}) for name in treatment_names}
    fingerprints = {json.dumps(value, sort_keys=True) for value in contracts.values()}
    if len(fingerprints) > 1:
        raise ValueError("Treatment execution settings differ; DETAIL must be the only variable")
    return contracts[treatment_names[0]] if treatment_names else {}


def _write_attempt_evidence(
    task,
    test_dir: Path,
    result,
    passed: list[str],
    failed: list[str],
    execution: dict,
    task_variant: str | None,
    rep_index: int,
) -> None:
    raw_dir = os.environ.get("BENCH_ATTEMPT_EVIDENCE_DIR")
    if not raw_dir:
        return
    evidence_dir = Path(raw_dir)
    evidence_dir.mkdir(parents=True, exist_ok=True)
    (evidence_dir / "agent_trajectory.jsonl").write_text(result.stdout or "", encoding="utf-8")

    source_results = test_dir / "_test_results.json"
    if source_results.exists():
        (evidence_dir / "_test_results.json").write_bytes(source_results.read_bytes())
    elif not (evidence_dir / "_test_results.json").exists():
        (evidence_dir / "_test_results.json").write_text("{}\n", encoding="utf-8")

    diff_lines: list[str] = []
    relative_files = {
        path.relative_to(task.environment_dir)
        for path in task.environment_dir.rglob("*")
        if path.is_file()
    } | {
        path.relative_to(test_dir)
        for path in test_dir.rglob("*")
        if path.is_file()
        and not any(part.startswith(".") for part in path.relative_to(test_dir).parts)
        and not any(
            part in {"node_modules", "__pycache__", "scaffold", "validation", "data"}
            for part in path.relative_to(test_dir).parts
        )
    }
    for relative in sorted(relative_files):
        before_path = task.environment_dir / relative
        after_path = test_dir / relative
        try:
            before = (
                before_path.read_text(encoding="utf-8").splitlines(keepends=True)
                if before_path.exists()
                else []
            )
            after = (
                after_path.read_text(encoding="utf-8").splitlines(keepends=True)
                if after_path.exists()
                else []
            )
        except UnicodeDecodeError:
            continue
        if before != after:
            diff_lines.extend(
                difflib.unified_diff(
                    before,
                    after,
                    fromfile=f"a/{relative}",
                    tofile=f"b/{relative}",
                )
            )
    (evidence_dir / "diff.patch").write_text("".join(diff_lines), encoding="utf-8")
    (evidence_dir / "runner_result.json").write_text(
        json.dumps(
            {
                "passed": passed,
                "failed": failed,
                "returncode": result.returncode,
                "task_variant": task_variant,
                "rep": rep_index,
                "execution": {
                    "model": execution.get("model"),
                    "timeout_sec": execution.get("timeout_sec"),
                    "system_prompt": execution.get("system_prompt"),
                    "system_prompt_applied_via": "CLAUDE.md",
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


@pytest.mark.timeout(PYTEST_TIMEOUT)
def test_task_treatment(task_name, treatment_name, rep_index, task_variant):
    """Run a task with a treatment and validate results."""
    fixtures = get_fixtures()
    task = load_task(task_name)
    treatments = load_treatments()
    dynamic = conftest._get_dynamic_treatment_config(fixtures.request_config)
    if dynamic:
        treatments[dynamic.name] = dynamic
    if treatment_name not in treatments:
        pytest.skip(f"Treatment {treatment_name} not found")
    treatment_cfg = treatments[treatment_name]
    if task.config.evaluation.profile == "detail-less-bem":
        compared_treatments = [name for name in task.default_treatments if name in treatments] or [
            treatment_name
        ]
        execution = _execution_contract(treatments, compared_treatments)
    else:
        execution = dict(treatment_cfg.execution or {})
    skill_hints = treatment_cfg.skills[0] if treatment_cfg.skills else {}
    validators = task.load_validators()

    skills = build_treatment_skills(treatment_cfg.skills) if treatment_cfg.skills else {}
    skill_sources = [
        skill.get("source")
        for skill in skills.values()
        if isinstance(skill, dict) and skill.get("source")
    ]
    eval_manifest = next(
        (cfg.get("manifest") for cfg in treatment_cfg.skills if cfg.get("manifest")),
        None,
    )
    treatment = Treatment(
        description=treatment_cfg.description,
        skills=skills,
        claude_md=treatment_cfg.claude_md if treatment_cfg.claude_md else None,
    )

    run_id = str(uuid.uuid4())

    template_vars = {"run_id": run_id}
    for var_name, var_template in task.config.setup.template_vars.items():
        template_vars[var_name] = var_template.format(run_id=run_id)

    prompt = task.render_prompt(task_variant=task_variant, **template_vars)
    target_profile = None
    if treatment_cfg.skills:
        target_profile = treatment_cfg.skills[0].get("profile")
    profile_name = resolve_profile_name(
        task,
        override=fixtures.request_config.getoption("--profile"),
        target_profile=target_profile,
    )
    system_prompt = execution.get("system_prompt")
    claude_md = conftest._build_eval_claude_md(profile_name, treatment.claude_md)
    if system_prompt:
        claude_md = "\n\n".join(section for section in (system_prompt, claude_md) if section)
    fixtures.setup_test_context(
        skills=treatment.skills,
        claude_md=claude_md,
        environment_dir=task.environment_dir,
    )
    interaction = conftest._resolve_interaction_config(task, profile_name, fixtures.request_config)
    skill_package_path = conftest._snapshot_dynamic_skill_package(
        fixtures.test_dir, skill_hints
    ) or skill_hints.get("path")

    result = fixtures.run_claude(
        prompt,
        timeout=int(execution.get("timeout_sec", CLAUDE_TIMEOUT)),
        model=execution.get("model"),
        interaction=interaction,
    )

    events = extract_events(parse_output(result.stdout))
    outputs = {
        "run_id": run_id,
        "treatment_name": treatment_name,
        "events": events,
        "profile": profile_name,
        "skill_sources": skill_sources,
        "eval_manifest": eval_manifest,
        "required_skills": skill_hints.get("required_skills")
        or task.config.evaluation.required_skills,
        "expected_artifacts": skill_hints.get("expected_artifacts")
        or task.config.evaluation.expected_artifacts,
        "require_skill_invocation": task.config.evaluation.require_skill_invocation,
        "rubric_criteria": task.config.evaluation.rubric_criteria,
        "skill_package_path": skill_package_path,
        "generated_node_skills": skill_hints.get("generated_node_skills") or [],
        "route_conformance_task": skill_hints.get("route_conformance_task"),
        "route_conformance_expected_node_order": (
            skill_hints.get("route_conformance_expected_node_order") or []
        ),
        "baseline_treatments": skill_hints.get("baseline_treatments") or [],
        "quality_gates": skill_hints.get("quality_gates") or {},
        "required_output_schemas": skill_hints.get("required_output_schemas") or [],
        "expected_evidence": skill_hints.get("expected_evidence") or [],
        "draft_hash": skill_hints.get("draft_hash"),
        "interaction": {
            "mode": interaction.mode,
            "max_turns": interaction.max_turns,
        },
        "task_variant": task_variant,
        "rep": rep_index,
        "execution": {
            "model": execution.get("model"),
            "timeout_sec": execution.get("timeout_sec"),
            "system_prompt": execution.get("system_prompt"),
            "system_prompt_applied_via": "CLAUDE.md" if system_prompt else None,
        },
    }
    events["profile"] = outputs["profile"]
    events["skill_sources"] = outputs["skill_sources"]
    events["eval_manifest"] = outputs["eval_manifest"]
    events["interaction"] = outputs["interaction"]
    events["task_variant"] = outputs["task_variant"]
    events["rep"] = outputs["rep"]
    events["execution"] = outputs["execution"]

    passed, failed = run_validators(validators, fixtures.test_dir, outputs)
    completion_slices = _split_comet_completion_checks(passed, failed)
    passed, failed = _filter_control_workflow_checks(
        profile_name,
        treatment_name,
        passed,
        failed,
    )

    # Rubric scoring: feed the baseline validator outcome as the "completion"
    # dimension input, then append the eight [RUBRIC] messages as informational
    # checks (they never produce hard failures).
    rubric_outputs = dict(outputs)
    rubric_outputs["completion"] = {"passed": passed, "failed": failed}
    if profile_name == "comet-workflow":
        rubric_outputs.update(completion_slices)
        if _is_control_business_only_run(profile_name, treatment_name):
            rubric_outputs["workflow_completion"] = {"passed": [], "failed": []}
    rubric_passed, rubric_failed = run_profile_rubric(
        profile_name, fixtures.test_dir, rubric_outputs
    )
    passed = passed + rubric_passed
    failed = failed + rubric_failed

    _write_attempt_evidence(
        task,
        fixtures.test_dir,
        result,
        passed,
        failed,
        execution,
        task_variant,
        rep_index,
    )

    fixtures.record_result(
        events,
        passed,
        failed,
        run_id=run_id,
        returncode=result.returncode,
        stdout=result.stdout,
        stderr=result.stderr,
    )

    if failed:
        pytest.fail(f"Validation failed: {failed}")
