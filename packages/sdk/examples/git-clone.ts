import { createSandbox } from "../src";
import { local } from "../src/providers/local";

await using sandbox = await createSandbox({ provider: local() });

// Clone uses `run`. Pass auth: { token } for private repositories.
const { path } = await sandbox.git.clone("https://github.com/octocat/Hello-World.git", {
  depth: 1,
});
console.log((await sandbox.files.list(path)).map((entry) => entry.name));
