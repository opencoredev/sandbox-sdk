import { expect, test } from "vitest";
import { execute, quote, type Guest } from "../src/providers/boxd/guest.js";
import { MockGuest } from "./cloud-guest-mock.js";

test("drains final output when completion appears during a poll", async () => {
  const local = await MockGuest.create();
  let completed = false;
  const guest: Guest = {
    name: "offline",
    upload: (path, bytes) => local.upload(path, bytes),
    destroy: () => local.destroy(),
    raw: async (command) => {
      // Publish final output precisely when the poll opens the completion file.
      if (command.startsWith("nohup ")) return "";
      if (!completed && command.includes("root=sys.argv[1]; pos=")) {
        completed = true;
        command = command.replace(
          "import sys,json,os\n",
          quote(`import sys,json,os,builtins
original_open=builtins.open
def controlled_open(path,*args,**kwargs):
 if path==sys.argv[1]+'/exit':
  with original_open(sys.argv[1]+'/out','w') as f: f.write(json.dumps(['stdout','RklOQUwgT1VUUFVU'])+'\\n')
  with original_open(path,'w') as f: json.dump(dict(exitCode=0,timedOut=False),f)
 return original_open(path,*args,**kwargs)
builtins.open=controlled_open
`).slice(1, -1),
        );
      }
      return local.raw(command);
    },
  };
  const chunks: string[] = [];
  try {
    expect(
      await execute(guest, {
        command: "unused",
        cwd: local.root,
        env: {},
        timeoutMs: 5000,
        onChunk: (chunk) => chunks.push(chunk.text),
      }),
    ).toEqual({ exitCode: 0, timedOut: false });
    expect(chunks.join("")).toBe("FINAL OUTPUT");
  } finally {
    await local.destroy();
  }
});
