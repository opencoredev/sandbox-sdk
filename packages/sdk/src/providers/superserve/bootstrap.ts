import { python } from "../../shared/guest.js";
import { failure } from "./errors.js";

const initialize = python(`import os,json,shutil,sys,tempfile
v=json.loads(os.environ.pop('SANDBOX_SDK_BOOTSTRAP'))
if any(shutil.which(tool) is None for tool in ('git','tar','nohup')): sys.exit(79)
os.makedirs('/workspace',exist_ok=True)
os.makedirs('/tmp/.sandbox-sdk',exist_ok=True)
os.makedirs(os.path.dirname('/var/lib/sandbox-sdk-env.json'),exist_ok=True)
if v.get('env') is not None:
 with tempfile.NamedTemporaryFile(mode='w',dir=os.path.dirname('/var/lib/sandbox-sdk-env.json'),delete=False) as f:
  json.dump(v['env'],f)
 os.replace(f.name,'/var/lib/sandbox-sdk-env.json')`);

export function bootstrapCommand(options: {
  env?: Record<string, string>;
  installPython?: boolean;
  execution?: boolean;
}) {
  const missingPython =
    options.installPython === true
      ? "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq python3 python3-venv python3-pip >/dev/null || exit 1"
      : "exit 78";

  if (options.execution)
    return {
      command: `if ! command -v python3 >/dev/null 2>&1; then ${missingPython}; fi; command -v git tar nohup >/dev/null || exit 79; mkdir -p /workspace /tmp/.sandbox-sdk`,
      env: { SANDBOX_SDK_BOOTSTRAP: JSON.stringify({ env: options.env }) },
    };

  return {
    command: `if ! command -v python3 >/dev/null 2>&1; then ${missingPython}; fi; ${initialize}`,
    env: { SANDBOX_SDK_BOOTSTRAP: JSON.stringify({ env: options.env }) },
  };
}

export function checkBootstrap(exitCode: number, id: string) {
  if (exitCode === 78)
    throw failure(
      "Template lacks python3; use a template with Python 3 or explicitly set installPython: true to allow apt installation",
      "unsupported",
      id,
    );

  if (exitCode === 79) throw failure("Template must include git, tar and nohup", "unsupported", id);
}
