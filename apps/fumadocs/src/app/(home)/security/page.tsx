import { Callout } from "fumadocs-ui/components/callout";
import { Card, Cards } from "fumadocs-ui/components/card";

export const metadata = {
  title: "Security",
  description: "Sandbox SDK trust boundaries and responsible disclosure.",
  alternates: { canonical: "/security" },
};

export default function SecurityPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-16 md:py-24">
      <div className="max-w-3xl">
        <p className="text-sm font-medium text-fd-primary">Security</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
          Management API, not isolation.
        </h1>
        <p className="mt-5 text-lg leading-8 text-fd-muted-foreground">
          Sandbox SDK normalizes provider management APIs. The selected provider supplies the
          security boundary.
        </p>
      </div>

      <Callout type="warn" className="mt-8" title="Isolation still needs application security">
        Local runs code inside AgentOS with deny-by-default networking, but AgentOS is still beta.
        Your application must enforce authentication, authorization, quotas and host hardening.
      </Callout>

      <Cards className="mt-10">
        <Card
          title="Responsible disclosure"
          description="Report vulnerabilities privately to security@opencore.dev. Do not include production credentials or customer data."
        />
        <Card
          title="Credentials"
          description="Provider credentials stay in official SDK configuration. Errors and serialized preview objects redact access tokens."
        />
        <Card
          title="Preview URLs"
          description="Authenticated preview requests keep tokens inside request functions rather than JSON output or examples."
        />
        <Card
          title="Local isolation"
          description="Local runs guest files, processes and sockets inside an AgentOS WebAssembly/V8 VM instead of host child processes."
        />
        <Card
          title="Cleanup"
          description="Stop is idempotent and withSandbox attempts cleanup after every callback outcome."
        />
        <Card
          title="Provider differences"
          description="Network policy, persistence, authentication and snapshot semantics differ. Check provider capabilities."
        />
      </Cards>
    </main>
  );
}
