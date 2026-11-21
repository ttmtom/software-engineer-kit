# Frontend TypeScript Profile

## Architecture
- Define strict typed contracts for UI props, form states, and serialized API responses matching backend schemas.
- Separate browser-safe modules from any server/build-time utilities.

## Implement
- Avoid `any` and unsafe `as` casts on API payloads or DOM events; narrow unknown errors safely before rendering messages.
- Propagate `AbortSignal` into client `fetch` requests to cancel stale in-flight requests cleanly.

## Test
- Run `tsc --noEmit` with component/UI tests so prop and API contract mismatches fail early.
- Test strict null/empty/optional payload branches and aborted fetch handling.

## Review
- Flag `any` or unsafe casts on API responses, unhandled rejected promises in event handlers, and accidental server-only imports in client bundles.
