# Backend Profile

## Architecture
- Define explicit API contracts (methods, paths, schemas, pagination, status codes, and error shapes).
- Specify authentication, authorization (ownership/RBAC), rate/size bounds, and idempotency guarantees up front.
- Design clear boundaries between transport/handlers, business logic/services, and persistence/external clients.

## Implement
- Validate and normalize all untrusted inputs at the boundary before passing them into domain logic.
- Enforce authorization checks explicitly on every resource operation (prevent IDOR/privilege escalation).
- Propagate request context/timeouts, handle partial failures cleanly, and return structured errors without leaking internal traces.
- Emit structured logs/metrics with correlation IDs and zero secrets or PII.

## Test
- Test happy paths plus boundary/error cases (`400` validation, `401` unauthenticated, `403` unauthorized, `404` missing, `409` conflict).
- Verify idempotency, concurrency behavior, and error propagation across handler -> service -> store boundaries.
- Keep external dependencies isolated or cleanly mocked without hiding real contract mismatches.

## Review
- Audit authn/authz enforcement on every endpoint/mutation (especially object-level ownership checks).
- Check for unhandled async errors, missing timeouts, unbounded queries/payloads, and N+1 external/DB calls.
- Verify HTTP status codes and error responses match the architecture contract.
