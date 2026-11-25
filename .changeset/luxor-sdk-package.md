---
"@opencoredev/sandbox-sdk": minor
---

The `tenki()` adapter now loads Luxor's SDK from `@luxorai/sandbox`, the name Luxor publishes it under, and needs version 1.6.0 or later. Replace `@tenkicloud/sandbox` with `@luxorai/sandbox` in your dependencies: it is the same code at the same version. Nothing else changes: the `tenki()` factory, the `/tenki` import path, `box.provider` and the `TENKI_*` environment variables stay as they are.

With a network allow list, `tenki()` now also fails the create, and deletes the VM, when Luxor returns HTTPS interception, extra allowed ports, HTTP rules or named egress policies the app did not ask for.
