import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { guestSpec } from "../src/providers/freestyle/wire.js";

test("a real Python interpreter decodes the one-shot request without loading JSON", () => {
  const spec = {
    command: "printf '雪🙂\\n'",
    cwd: "/workspace",
    stdin: "\0input\r\n🙂",
    env: { TOKEN: "'$(printf private)\n雪", CI: "1" },
    timeoutMs: 120_000,
    files: [["/var/lib/sandbox-sdk.json", '{"key":null}']] satisfies [string, string][],
  };

  const output = execFileSync(
    "python3",
    [
      "-S",
      "-c",
      "import marshal,sys; v=marshal.loads(bytes.fromhex(sys.argv[1])); assert 'json' not in sys.modules; import json; print(json.dumps(v))",
      guestSpec(spec).toString("hex"),
    ],
    { encoding: "utf8", timeout: 5000 },
  );

  expect(JSON.parse(output)).toEqual(spec);
});
