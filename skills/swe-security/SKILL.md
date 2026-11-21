---
name: swe-security
description: Conduct OWASP Top 10 audits, lightweight STRIDE threat modeling, and secrets scanning across code and configs.
---

# SWE Security

Identify security vulnerabilities, architectural trust-boundary gaps, and secret exposures using evidence-verified
analysis.

## Stage Access

- Operate **read-only** by default during `research`, `architecture`, `plan`, and `review`.
- Apply security fixes during `implement` and add regression/abuse-case tests during `test`.

## 1. Lightweight STRIDE Threat Modeling

Use during `research` and `architecture` (or when reviewing new boundaries):

- **Assets & Entry Points:** List sensitive data (credentials, tokens, PII, tenant/financial records) and untrusted
  inputs (HTTP, RPC, webhooks, CLI args, file uploads, env/IPC).
- **Trust Boundaries:** Map privilege transitions (anonymous -> authenticated, user -> admin, tenant A -> tenant B,
  internal service -> third-party URL).
- **STRIDE Matrix:** Check **S**poofing (authn), **T**ampering (signatures/integrity), **R**epudiation (audit logs),
  **I**nformation Disclosure (PII/error leaks), **D**enial of Service (unbounded payloads/queries/timeouts), and **E**
  levation of Privilege (authz/IDOR/RBAC).

## 2. OWASP Checklist

Audit changed code and surrounding callers against relevant OWASP Top 10 / ASVS controls:

- **Broken Access Control (A01):** Default-deny authorization, object-level ownership checks (prevent IDOR), privilege
  escalation guards, path traversal prevention, safe CORS/CSRF settings.
- **Cryptographic & Auth Failures (A02/A07):** Strong password hashing (`argon2`/`scrypt`/`bcrypt`), CSPRNG tokens,
  constant-time secret comparison, strict JWT/session validation (algorithm pinning, expiry, rotation, `HttpOnly`/
  `Secure`/`SameSite` cookies).
- **Injection & SSRF (A03/A10):** Parameterized SQL/ORM queries, shell-free process execution (`execFile`/`spawn` with
  arg arrays), output encoding/CSP for XSS, URL/IP allowlisting and redirect restrictions for SSRF.
- **Misconfiguration, Integrity & Logging (A05/A08/A09):** Safe production defaults, pinned dependencies/lockfiles, safe
  deserialization, structured security logs with zero secrets/tokens/PII, and sanitized external error responses.

## 3. Secrets & Credential Scanning

- Search diffs, configs, scripts, and test fixtures (`grep`) for hardcoded API keys, bearer/JWT tokens, private keys
  (`BEGIN .* PRIVATE KEY`), DB URLs with embedded passwords, committed `.env` files, or provider tokens (`AKIA...`,
  `ghp_...`, `sk-...`).
- Verify `.gitignore` covers local secret files and tests use clearly synthetic placeholders.
- **Never echo real secrets verbatim** in findings or logs—always redact (e.g., `sk-proj-****`).

## Output & Severity

- Verify every candidate finding at an exact `file:line` in source before reporting; drop false positives.
- Order findings `critical` -> `major` -> `minor` -> `nit`, stating the attack vector/impact and concrete remediation
  (compatible with `swe_research_save`, `swe_architecture_save`, and `swe_review_record`).
