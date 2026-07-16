# Security policy

## Report a vulnerability

Email `security@opencore.dev` with a minimal reproduction, affected version and impact. Do not open a public issue before coordinated disclosure. Do not include production credentials, customer data, file contents or full authenticated preview URLs.

## Trust boundaries

Sandbox SDK normalizes sandbox management APIs. It does not provide execution isolation. The selected provider supplies the security boundary, authentication model, network controls, persistence and runtime hardening.

The Local provider loads its installed `@rivet-dev/agentos-core` dependency and executes guest code in a VM created by `AgentOs.create()`. Guest processes do not run as host child processes. Local denies outbound networking and host bindings by default and supplies finite VM limits.

AgentOS is currently beta and undergoing security review. Applications remain responsible for host hardening, authentication, tenant isolation, persistence, quotas and appropriately scoped overrides. Do not weaken Local's AgentOS permission policy for untrusted workloads without reviewing the resulting boundary.

## Credentials and preview tokens

Pass credentials through provider factories or the official SDK environment variables. Sandbox SDK does not add telemetry and must not log commands, files, paths, environment variables, API keys, preview URLs, stdout or stderr.

Authenticated preview tokens remain inside `ExposedPort.request()`. Serialized port objects omit request headers and redact sensitive query values. The original provider error remains available as `SandboxError.cause`; applications must avoid logging causes in untrusted contexts.

## Network and provider differences

Network access defaults and policy controls belong to each provider. A normalized capability indicates availability, not a universal security policy. Consult the provider page and official provider documentation before running sensitive workloads.

Snapshots also differ: they may capture filesystems, templates or memory and may create new sandboxes instead of restoring in place. Do not assume snapshots remove secrets or running state.

## Cleanup guarantees

`stop()` is idempotent. A sandbox created with `await using` invokes `stop()` when its scope exits after success or failure. The callback-style `withSandbox()` helper provides the same scoped cleanup behavior and preserves the original callback error if cleanup also fails. Cleanup is best effort: provider outages, process failures or host termination can prevent it. Configure provider-side timeouts and resource expiration as a second line of defense.

## What Sandbox SDK does not secure

Sandbox SDK does not validate user code, prevent malicious commands, scan file contents or rotate credentials. Local supplies AgentOS isolation and a deny-by-default network policy, but applications still own operational controls and the risks of the beta runtime.
