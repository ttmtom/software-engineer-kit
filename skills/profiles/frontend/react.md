# Frontend React Profile

## Architecture
- Separate presentational components, custom hooks/state management, and server-state fetching/caching cleanly.
- Plan component composition, error boundaries, and route/data-loading boundaries before implementation.

## Implement
- Keep state minimal and derived values computed during render rather than duplicated in `useEffect`.
- Provide clean `useEffect` cleanup functions (subscriptions, timers, `AbortController`) and accurate dependency arrays.
- Use stable, unique `key` props on lists (never array indices for reorderable/mutable lists).

## Test
- Test rendered components via user-centric queries (`getByRole`, `getByLabelText`, `userEvent`) across loading, success, empty, and error states.
- Verify interactive flows (modals, forms, disabled-while-submitting states) and error-boundary fallback behavior.

## Review
- Flag unnecessary `useEffect` state sync, stale closures, missing effect cleanups, unstable list keys, and missing disabled/pending guards on submit actions.
