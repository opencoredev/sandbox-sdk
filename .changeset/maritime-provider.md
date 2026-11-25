---
"@opencoredev/sandbox-sdk": minor
---

Add the Maritime provider, `@opencoredev/sandbox-sdk/maritime`: Maritime virtual machines through Maritime's REST API with no peer package. Streamed commands that run under `setsid`, so a timeout or abort kills and confirms the whole process group; files; private previews whose URL carries Maritime's `?token=` (`public: true` for public ports); pause, and resume by waking the sandbox; named snapshots with `deleteSnapshot`; presets and exact sizes; `network: "none"`; time limits and idle timeouts; and `box.native` on Maritime's control and data planes, whose `sdk()` binds a caller-installed `maritime-sdk`. A create carries an idempotency key and an allocation marker, so a lost answer is recovered and never mistaken for another caller's sandbox. `box.preview(port, { path })` now keeps a provider's query credentials on the new path.
