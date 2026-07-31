"""Evaluation profile registry for local and LangSmith suites."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from scaffold.python.paths import get_suite_root
from scaffold.python.tasks import InteractionConfig, Task
from scaffold.python.validation.core import ValidatorFn
from scaffold.python.validation.generic_rubric import (
    GENERIC_RUBRIC_DIMENSIONS,
    generic_rubric_validator,
)
from scaffold.python.validation.authoring_rubric import (
    AUTHORING_RUBRIC_DIMENSIONS,
    authoring_skill_rubric_validator,
)

GENERIC_PROFILE = "generic"
COMET_WORKFLOW_PROFILE = "comet-workflow"
AUTHORING_SKILL_PROFILE = "authoring-skill"

COMET_SIMULATOR_PROMPT = (
    "You are simulating a developer user in an automated eval. The AI assistant "
    "below is running the Comet development workflow and has paused to ask you "
    "something. Read its message and reply with a SHORT (1-3 sentences) response "
    "that approves reasonable plans, picks sensible defaults, and only asks for "
    "clarification when the requested outcome is unclear."
)

GENERIC_SIMULATOR_PROMPT = (
    "You are simulating a concise developer user in an automated eval. Answer "
    "the assistant's question in 1-3 sentences, choose reasonable defaults, and "
    "keep the task moving."
)


@dataclass(frozen=True)
class ProfileSpec:
    name: str
    rubric_dimensions: tuple[str, ...]
    default_interaction: InteractionConfig
    rubric: ValidatorFn


def _build_custom_profile_validator(config: dict[str, Any]) -> ValidatorFn:
    hard_checks = config.get("hard_checks") or {}
    rubrics = config.get("rubric") or []

    def validator(test_dir: Path, outputs: dict[str, Any]) -> tuple[list[str], list[str]]:
        passed: list[str] = []
        failed: list[str] = []
        hard_results: list[bool] = []

        target_artifacts = hard_checks.get("target_artifacts") or []
        missing_artifacts = [
            pattern for pattern in target_artifacts if not any(test_dir.glob(pattern))
        ]
        artifacts_ok = not missing_artifacts
        hard_results.append(artifacts_ok)
        if artifacts_ok:
            passed.append("[HARD] target_artifacts: passed")
        else:
            failed.append(
                "[HARD] target_artifacts: missing " + ", ".join(missing_artifacts)
            )

        completion = outputs.get("completion") or {}
        completion_passed = [str(item).lower() for item in completion.get("passed", [])]
        completion_failed = [str(item).lower() for item in completion.get("failed", [])]
        aliases = {
            "check_public_less_exit_code": ("check-public-less", "public-less-checker"),
            "stylelint_exit_code": ("stylelint",),
            "build_exit_code": ("build",),
        }
        for field_name, field_aliases in aliases.items():
            if field_name not in hard_checks:
                continue
            expected = hard_checks[field_name]
            has_failed = any(
                alias in item for item in completion_failed for alias in field_aliases
            )
            has_passed = any(
                alias in item for item in completion_passed for alias in field_aliases
            )
            check_ok = expected == 0 and has_passed and not has_failed
            hard_results.append(check_ok)
            if check_ok:
                passed.append(f"[HARD] {field_name}: {expected}")
            elif has_failed:
                failed.append(
                    f"[HARD] {field_name}: expected {expected}, completion reported failure"
                )
            else:
                failed.append(f"[HARD] {field_name}: no completion evidence")

        passed_count = sum(hard_results)
        total_count = len(hard_results)
        rubric_scores: list[float] = []
        for rubric in rubrics:
            minimum = float(rubric.get("min_score", 0))
            maximum = float(rubric.get("max_score", 2))
            midpoint = (minimum + maximum) / 2
            if total_count and passed_count == total_count:
                score = maximum
            elif total_count and passed_count * 2 >= total_count:
                score = midpoint
            else:
                score = minimum
            rubric_scores.append(score)
            passed.append(
                f"[RUBRIC] {rubric['name']}: {score:.2f} - "
                f"hard-check proxy {passed_count}/{total_count} passed; no LLM score used"
            )

        if rubric_scores:
            passed.append(
                f"[RUBRIC] weighted_score: {sum(rubric_scores) / len(rubric_scores):.2f}"
            )
        return passed, failed

    return validator


def _load_custom_profiles() -> dict[str, ProfileSpec]:
    profiles_dir = get_suite_root() / "profiles"
    if not profiles_dir.exists():
        return {}

    profiles: dict[str, ProfileSpec] = {}
    for profile_path in sorted(profiles_dir.glob("*.toml")):
        with profile_path.open("rb") as profile_file:
            config = tomllib.load(profile_file)
        name = config.get("name", profile_path.stem)
        rubrics = config.get("rubric") or []
        profiles[name] = ProfileSpec(
            name=name,
            rubric_dimensions=tuple(rubric["name"] for rubric in rubrics),
            default_interaction=InteractionConfig(
                mode="none",
                max_turns=12,
                simulator_prompt=GENERIC_SIMULATOR_PROMPT,
            ),
            rubric=_build_custom_profile_validator(config),
        )
    return profiles


def _build_profiles() -> dict[str, ProfileSpec]:
    from scaffold.python.validation.rubric import RUBRIC_DIMENSIONS, comet_rubric_validator

    profiles = {
        GENERIC_PROFILE: ProfileSpec(
            name=GENERIC_PROFILE,
            rubric_dimensions=GENERIC_RUBRIC_DIMENSIONS,
            default_interaction=InteractionConfig(
                mode="none",
                max_turns=12,
                simulator_prompt=GENERIC_SIMULATOR_PROMPT,
            ),
            rubric=generic_rubric_validator,
        ),
        COMET_WORKFLOW_PROFILE: ProfileSpec(
            name=COMET_WORKFLOW_PROFILE,
            rubric_dimensions=tuple(RUBRIC_DIMENSIONS),
            default_interaction=InteractionConfig(
                mode="auto_user",
                max_turns=12,
                simulator_prompt=COMET_SIMULATOR_PROMPT,
            ),
            rubric=comet_rubric_validator,
        ),
        AUTHORING_SKILL_PROFILE: ProfileSpec(
            name=AUTHORING_SKILL_PROFILE,
            rubric_dimensions=AUTHORING_RUBRIC_DIMENSIONS,
            default_interaction=InteractionConfig(
                mode="auto_user",
                max_turns=8,
                simulator_prompt=GENERIC_SIMULATOR_PROMPT,
            ),
            rubric=authoring_skill_rubric_validator,
        ),
    }
    profiles.update(_load_custom_profiles())
    return profiles


def list_profiles() -> list[str]:
    return sorted(_build_profiles())


def get_profile(name: str) -> ProfileSpec:
    profiles = _build_profiles()
    if name not in profiles:
        raise KeyError(f"Profile not found: {name}. Available: {list_profiles()}")
    return profiles[name]


def resolve_profile_name(
    task: Task,
    override: str | None = None,
    target_profile: str | None = None,
) -> str:
    if override:
        get_profile(override)
        return override
    if target_profile:
        get_profile(target_profile)
        return target_profile
    if task.config.evaluation.profile:
        get_profile(task.config.evaluation.profile)
        return task.config.evaluation.profile
    return GENERIC_PROFILE


def run_profile_rubric(
    profile_name: str,
    test_dir: Path,
    outputs: dict[str, Any],
) -> tuple[list[str], list[str]]:
    profile = get_profile(profile_name)
    return profile.rubric(test_dir, outputs)


def all_rubric_dimensions() -> tuple[str, ...]:
    seen: list[str] = []
    for profile in _build_profiles().values():
        for dim in profile.rubric_dimensions:
            if dim not in seen:
                seen.append(dim)
    return tuple(seen)
