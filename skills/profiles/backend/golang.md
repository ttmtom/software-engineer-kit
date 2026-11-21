# Backend Golang Profile

## Architecture
- Keep Go packages cohesive with small, consumer-defined interfaces and explicit dependency injection.
- Pass `context.Context` as the first parameter across HTTP/gRPC handlers, services, and repositories.
- Define sentinel/typed domain errors so transport handlers map failures to HTTP/gRPC codes cleanly without inspecting error strings.

## Implement
- Never ignore returned `error` values; wrap contextual errors with `fmt.Errorf("...: %w", err)` and match with `errors.Is` / `errors.As`.
- Respect `ctx.Done()` cancellation and manage goroutine lifecycles (`errgroup`, `WaitGroup`) with zero unbounded background spawns.
- Close `rows`, `resp.Body`, and files with `defer` (and check close errors on writable streams).
- Avoid shared mutable state without explicit synchronization (`sync.Mutex` or channels).

## Test
- Write idiomatic table-driven tests with `t.Run` subtests and clear `got ... want ...` failure messages.
- Run `go test -race ./...` and `go vet ./...` to catch data races and static issues.
- Test `context.Context` cancellation/timeouts and domain-error-to-status mapping.

## Review
- Flag ignored errors, goroutine leaks, missing `context.Context` propagation, and unclosed `rows` or `resp.Body`.
- Check for data races, `nil` interface traps, and `fmt.Errorf` using `%v` instead of `%w` where wrapping is expected.
