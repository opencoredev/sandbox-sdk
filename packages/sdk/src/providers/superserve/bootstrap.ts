import { python } from "../boxd/guest.js";
import { failure } from "./errors.js";
import { supervisor, supervisorPath } from "./execute.js";

const initialize = python(`import os,json,shutil,sys,tempfile
v=json.loads(os.environ.pop('SANDBOX_SDK_BOOTSTRAP'))
if any(shutil.which(tool) is None for tool in ('git','tar','nohup')): sys.exit(79)
os.makedirs('/workspace',exist_ok=True)
os.makedirs('/tmp/.sandbox-sdk',exist_ok=True)
os.makedirs(os.path.dirname('${supervisorPath}'),exist_ok=True)
if v.get('supervisor') is not None:
 if v.get('env') is not None or not os.path.exists('/var/lib/sandbox-sdk-env.json'):
  with tempfile.NamedTemporaryFile(mode='w',dir=os.path.dirname('/var/lib/sandbox-sdk-env.json'),delete=False) as f:
   json.dump(v.get('env') or {},f)
  os.replace(f.name,'/var/lib/sandbox-sdk-env.json')
 with tempfile.NamedTemporaryFile(mode='w',dir=os.path.dirname('/var/lib/sandbox-sdk-env.json'),delete=False) as f: f.write(v['supervisor'])
 os.replace(f.name,'${supervisorPath}')`);

export function bootstrapCommand(options: { env?: Record<string, string>; installPython?: boolean; execution?: boolean }) {
  const missingPython = options.installPython === true
    ? "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq python3 python3-venv python3-pip >/dev/null || exit 1"
    : "exit 78";
  return {
    command: `if ! command -v python3 >/dev/null 2>&1; then ${missingPython}; fi; ${initialize}`,
    env: { SANDBOX_SDK_BOOTSTRAP: JSON.stringify({ env: options.env, supervisor: options.execution ? supervisor : undefined }) },
  };
}

export function checkBootstrap(exitCode: number, id: string) {
  if (exitCode === 78) throw failure("Template lacks python3; use a template with Python 3 or explicitly set installPython: true to allow apt installation", "unsupported", id);
  if (exitCode === 79) throw failure("Template must include git, tar and nohup", "unsupported", id);
}
