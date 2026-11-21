# Frontend React + TypeScript Profile

## Architecture
- Type component props, discriminated UI states (`idle | loading | error | success`), and API client hooks strictly against backend contracts.
- Keep Server vs Client Component boundaries (`"use client"`) explicit when using React Server Components.

## Implement
- Type event handlers, refs, and custom hook returns explicitly without `any` or unsafe `as` assertions.
- Narrow unknown mutation/query errors cleanly before passing text to UI error banners.
- Avoid serializing non-plain values or leaking server-only types/secrets across client boundaries.

## Test
- Run `tsc --noEmit` alongside React Testing Library / Playwright tests.
- Verify typed form validation, pending-state button disabling, and API error-state rendering.

## Review
- Flag `any` props, unsafe casts on `fetch`/query data, missing `AbortSignal`/cleanup in typed hooks, and Server/Client boundary violations.
