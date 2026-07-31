"""Validation helpers for test scripts."""
from scaffold.python.validation.core import (
    ValidatorFn,
    check_file_exists,
    check_no_pattern,
    check_pattern,
    check_skill_invoked,
    compose_validators,
    run_validators,
)
__all__ = [
    "ValidatorFn", "compose_validators", "run_validators",
    "check_file_exists", "check_pattern", "check_no_pattern", "check_skill_invoked",
    "check_code_execution", "check_python_execution", "check_typescript_execution",
]


def __getattr__(name: str):
    """Load Docker-backed helpers only when a host-side caller requests them.

    Validator containers import ``validation.core`` for the result-file protocol.
    Keeping the Docker helpers lazy avoids importing host orchestration dependencies
    (for example ``dotenv``) inside those minimal task images.
    """
    if name in {"check_code_execution", "check_python_execution", "check_typescript_execution"}:
        from scaffold.python.validation import docker

        return getattr(docker, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
