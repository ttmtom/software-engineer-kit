# Backend TypeScript Profile

## Architecture
- Model domain states and error results with discriminated unions; validate external request/env payloads with runtime schemas (not compile-time types alone).
- Keep transport adapters (Express/Fastify/Hono/Nest), domain services, and DB/HTTP clients cleanly separated.

## Implement
- Avoid `any`, non-null assertions (`!`), and unsafe `as` casts on request bodies, params, or external API responses.
- Propagate `AbortSignal` / request timeouts and ensure every async operation is awaited or explicitly handled.
- Keep Node/Bun server modules free of browser assumptions and validate env config at startup.

## Test
- Run `tsc --noEmit` alongside API unit/integration tests.
- Test invalid runtime payloads, schema validation rejections, and aborted/timed-out async calls.

## Review
- Flag unvalidated `req.body` casts, `any` leaks at API boundaries, floating unawaited promises, and missing `AbortSignal`/timeout handling.
