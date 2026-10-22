import type { Sandbox } from "@superserve/sdk";
import { python } from "../boxd/guest.js";
import { failure } from "./errors.js";
import { supervisor, supervisorPath } from "./execute.js";

const initialize = python(`import os,json,shutil,sys
v=json.loads(os.environ.pop('SANDBOX_SDK_BOOTSTRAP'))
if any(shutil.which(tool) is None for tool in ('git','tar','nohup')): sys.exit(79)
os.makedirs('/workspace',exist_ok=True)
os.makedirs('/tmp/.sandbox-sdk',exist_ok=True)
os.makedirs(os.path.dirname('${supervisorPath}'),exist_ok=True)
with open(os.open('/var/lib/sandbox-sdk-env.json',os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600),'w') as f:
 os.fchmod(f.fileno(),0o600)
 json.dump(v['env'],f)
with open('${supervisorPath}','w') as f: f.write(v['supervisor'])`);

export async function bootstrap(
  box: Sandbox,
  options: { env: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
) {
  const result = await box.commands.run(
    `(command -v python3 >/dev/null || (export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq python3 python3-venv python3-pip >/dev/null)) && ${initialize}`,
    {
      // Keep caller environment values out of the shell command and its argv.
      env: { SANDBOX_SDK_BOOTSTRAP: JSON.stringify({ env: options.env, supervisor }) },
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    },
  );
  if (result.exitCode === 79)
    throw failure("Template must include git, tar and nohup", "unsupported", box.id);
  if (result.exitCode !== 0) throw failure("Guest initialization failed", "provider", box.id);
}
