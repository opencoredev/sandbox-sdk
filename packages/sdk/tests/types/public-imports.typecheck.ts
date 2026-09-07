import type {
  CreateSandboxOptions,
  ProviderCreateOptions,
  SandboxProvider,
  SandboxRuntime,
} from "@opencoredev/sandbox-sdk";

const publicProviderTypes:
  | [
      CreateSandboxOptions<SandboxProvider<unknown>>,
      ProviderCreateOptions,
      SandboxProvider<unknown>,
      SandboxRuntime<unknown>,
    ]
  | null = null;
void publicProviderTypes;

// @ts-expect-error Providers outside the supported provider set are not exported.
import "@opencoredev/sandbox-sdk/modal";
// @ts-expect-error Internal runtime contracts are not public subpaths.
import "@opencoredev/sandbox-sdk/core/provider";
