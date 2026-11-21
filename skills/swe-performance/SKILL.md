---
name: swe-performance
description: Guide profiling, reproducible benchmark design, and targeted optimization patterns with measured before/after evidence.
---

# SWE Performance

Diagnose bottlenecks empirically, design reliable benchmarks, and apply targeted optimizations without sacrificing
correctness or maintainability.

## Stage Access

- Operate **read-only** during `research`, `architecture`, and `review` to analyze hot paths, design experiments, and
  review regressions.
- Implement optimizations and runnable benchmarks during `implement` and `test`.

## Core Rule: Measure First

- Never optimize on guesswork alone. Establish a reproducible baseline and identify the true bottleneck (CPU, heap/GC,
  event-loop blocking, DB query/locks, network I/O, or frontend rendering/bundle size) before changing code.

## 1. Profiling Guidance

- **CPU & Memory:** Capture CPU profiles/flamegraphs and heap/allocation profiles under realistic workloads (e.g.,
  `node --cpu-prof` / `--heap-prof`, `go test -cpuprofile -memprofile -benchmem`, Chrome DevTools Performance/Memory,
  `perf`).
- **Database & I/O:** Inspect `EXPLAIN ANALYZE` plans, query counts (N+1 queries), lock contention, connection pool
  saturation, serialization/compression cost, and request waterfalls.
- **Frontend:** Measure Core Web Vitals (LCP, INP, CLS), long main-thread tasks, unnecessary re-renders, and
  bundle/chunk payload sizes.

## 2. Benchmark Design

- Specify dataset size/distribution, concurrency, environment, and target metrics (`p50`/`p95`/`p99` latency, throughput
  ops/sec, allocations/op, peak RSS).
- Warm up JIT/caches before timing, isolate fixture setup/teardown from the measured loop, and prevent dead-code
  elimination or constant folding of unused results.
- Run multiple iterations and report variance/percentiles rather than cherry-picking single runs.

## 3. Optimization Patterns & Trade-offs

- **Algorithmic & Data Structures:** Reduce time/space complexity, eliminate redundant passes/sorts, and choose
  appropriate lookup structures.
- **I/O & Query Efficiency:** Batch N+1 queries, add selective indexes, stream large payloads with backpressure, and
  enforce bounded concurrency/timeouts.
- **Caching & Reuse:** Cache hot read paths with explicit invalidation/TTL and bounded capacity (LRU/size limits) to
  prevent memory leaks.
- **Hot-Path Allocations:** Hoist invariant regexes/parsers out of loops, reuse buffers where safe, and avoid redundant
  JSON/string copies while keeping invariants clear.

## Output & Verification

- Report baseline vs. post-change metrics, exact commands/workloads used, memory/complexity trade-offs, and confirm all
  functional tests remain green via `swe_verify` / `swe_test_record`.
