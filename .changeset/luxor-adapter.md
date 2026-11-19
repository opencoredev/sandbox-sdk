---
"@opencoredev/sandbox-sdk": minor
---

The Tenki adapter is now the Luxor adapter. Import `luxor()` from `@opencoredev/sandbox-sdk/luxor` and install `@luxorai/sandbox`, the name Luxor now publishes its SDK under. The adapter reads `LUXOR_AUTH_TOKEN` and `LUXOR_API_KEY` first, and the API endpoint defaults to `https://api.luxor.ai`.

`tenki()` from `@opencoredev/sandbox-sdk/tenki` stays as a deprecated alias, and the `TENKI_*` variables are still read. Two things change for code that uses it: the peer package is `@luxorai/sandbox` instead of `@tenkicloud/sandbox` (the same code at the same version), and `box.provider` and the `provider` field on errors are now `"luxor"`.
