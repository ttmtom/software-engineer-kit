# DevOps Profile

## Architecture
- Design reproducible, immutable builds and environment-agnostic config (12-factor env vars/secret references, zero baked secrets).
- Enforce least-privilege IAM/RBAC, network isolation, healthchecks, and clear rollback strategies.
- Include observability hooks (structured logs, health/readiness endpoints, metrics).

## Implement
- Pin container base image versions/digests and toolchain versions (avoid mutable `:latest` tags in production).
- Run containers as non-root users with minimal runtime layers (`.dockerignore`, multi-stage builds) and explicit resource limits.
- Make CI/CD scripts and IaC idempotent, fail-fast (`set -euo pipefail` in bash), and secret-safe (never echo credentials).

## Test
- Run dry-run/validation checks (`docker build`, `docker compose config`, `terraform validate/plan`, `yamllint`/`shellcheck`, CI workflow lint).
- Verify startup/readiness healthchecks and rollback/failure behavior where testable locally.

## Review
- Reject hardcoded secrets, overly permissive IAM/network rules (`*`, `0.0.0.0/0` where unintended), mutable `:latest` tags, and root containers without justification.
- Check for missing timeouts, missing healthchecks, non-idempotent provisioning steps, and unquoted shell variables.
