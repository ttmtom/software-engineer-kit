# Frontend Profile

## Architecture
- Separate UI presentation, client state, and server/API data fetching cleanly.
- Plan explicit loading, empty, error, and optimistic/retry states before coding.
- Define accessible interaction semantics (keyboard navigation, focus management, ARIA roles) and responsive breakpoints.

## Implement
- Keep components focused and composable; avoid prop drilling when composition or local state fits better.
- Handle loading, empty, and error states explicitly; never swallow failed network requests silently.
- Ensure interactive elements use semantic HTML (`button`, `a`, form controls) with proper labels and keyboard support.
- Avoid unnecessary re-renders, layout shifts, and uncleaned effects/subscriptions.

## Test
- Test user-visible behavior (DOM roles, labels, state transitions) rather than internal implementation details.
- Verify loading, error, empty, and validation-failure states alongside happy paths.
- Check accessibility basics (keyboard flow, labels, contrast/semantics) and responsive/E2E flows where configured.

## Review
- Check for XSS sinks (`dangerouslySetInnerHTML`, unsanitized URLs), stale effect closures, and race conditions in async fetches.
- Verify error/loading states, keyboard/a11y regressions, and accidental client-bundle leaks of server secrets.
