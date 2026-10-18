# Sandbox SDK provider benchmark

SDK 1.0.0 · 2026-10-18T04:25:11.139Z
AMD Ryzen 9 9955HX 16-Core Processor · 32 logical CPUs · 92.0 GiB RAM · linux 7.0.0-31-generic · x64 · Bun 1.4.2 (Node API 26.3.0)

Runs: 20; warmups: 2; concurrency: 1.

| Provider | Scenario | Unit | n | Fail | Skip | p50 | p95 | p99 | Mean | Min | Max |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| memory | cold | ms | 20 | 0 | 0 | 1.0163 | 1.2459 | 1.6912 | 1.0335 | 0.6206 | 1.6912 |
| memory | command | ms | 20 | 0 | 0 | 0.1213 | 0.2722 | 0.8985 | 0.1828 | 0.0413 | 0.8985 |
| memory | files-1kb | ms | 20 | 0 | 0 | 0.0745 | 0.1473 | 0.1758 | 0.0807 | 0.0359 | 0.1758 |
| memory | files-10mb | ms | 20 | 0 | 0 | 25.2827 | 31.5354 | 37.5457 | 25.6332 | 12.8362 | 37.5457 |
| memory | dev-server | ms | 0 | 0 | 20 | — | — | — | — | — | — |
| memory | preview-first-byte | ms | 0 | 0 | 20 | — | — | — | — | — | — |
| memory | destroy | ms | 20 | 0 | 0 | 0.2376 | 0.4186 | 1.3406 | 0.3004 | 0.1339 | 1.3406 |
| memory | raw-cpu | cpu-ms/call | 20 | 0 | 0 | 0.0002 | 0.0003 | 0.0003 | 0.0002 | 0.0001 | 0.0003 |
| memory | sdk-cpu | cpu-ms/call | 20 | 0 | 0 | 0.0166 | 0.0283 | 0.0286 | 0.0177 | 0.0097 | 0.0286 |
| memory | overhead-cpu | cpu-ms/call | 20 | 0 | 0 | 0.0164 | 0.0281 | 0.0285 | 0.0175 | 0.0095 | 0.0285 |

## Notes

- percentiles: Nearest rank; successful measured samples only. Warmups excluded. Null statistics mean no successful samples.
- cold: Fresh sandbox create through first successful true command; includes SDK initialization, excludes provider module/factory load. Image/cache state is provider controlled.
- files: Binary 1024 and 10485760 bytes; combined write+read with byte equality validation included in timing.
- cpu: 100 mocked-native calls per batch; process.cpuUsage user+system / 100 in ms/call. SDK minus raw is paired per batch; order alternates; serial after latency workers. Includes SDK bookkeeping, excludes fixture setup. Other host activity, GC and JIT can add noise.
- memory region: unknown.
- memory/dev-server: Memory does not launch Node or bind sockets
- memory/preview-first-byte: Memory previews use .memory.invalid; no HTTP request made
