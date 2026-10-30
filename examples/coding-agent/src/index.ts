import { parseArgs } from "node:util";
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { runAgent, repoDir, type AgentEvent } from "./agent.js";
import { resolveModel } from "./model.js";
import { loadProvider, parseProviderName } from "./sandbox.js";
import { scriptedModel, type ScriptedStep } from "./scripted.js";

const usage = `Usage: bun start "<task>" --repo <git url> [--branch <name>] [--keep <key>] [--dry-run]

  --repo     Git URL to clone into the sandbox (required)
  --branch   Branch to check out
  --keep     Keep the sandbox under this key; rerun with the same key to reuse it
  --dry-run  Replay a fixed tool script instead of calling a model (no API key needed)`;

interface Cli {
  task: string;
  repo: string;
  branch: string | undefined;
  keep: string | undefined;
  dryRun: boolean;
}

function parseCli(argv: string[]): Cli {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      branch: { type: "string" },
      keep: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const dryRun = values["dry-run"];

  const task =
    positionals.join(" ").trim() ||
    (dryRun ? "Write AGENT_NOTES.md describing the repository layout." : "");

  if (values.help || !values.repo || !task) {
    console.error(usage);
    process.exit(values.help ? 0 : 2);
  }

  return { task, repo: values.repo, branch: values.branch, keep: values.keep, dryRun };
}

/** What --dry-run "decides": inspect, write a file, check status. Real tools, real sandbox. */
function dryRunScript(task: string): ScriptedStep[] {
  return [
    {
      say: "Looking around the repository.",
      calls: [{ tool: "run", input: { command: "git log --oneline -3 && ls -a" } }],
    },
    {
      say: "Writing the notes file.",
      calls: [
        {
          tool: "write_file",
          input: {
            path: "AGENT_NOTES.md",
            content: `# Agent notes\n\nTask: ${task}\n\nThis file was written by the coding-agent example in --dry-run mode.\n`,
          },
        },
      ],
    },
    { calls: [{ tool: "run", input: { command: "git status --short" } }] },
  ];
}

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const amber = (text: string) => `\x1b[33m${text}\x1b[0m`;

function print(event: AgentEvent) {
  switch (event.kind) {
    case "text":
      process.stdout.write(event.text);
      break;
    case "call":
      process.stdout.write(
        `\n${amber("→")} ${event.tool} ${dim(JSON.stringify(event.input).slice(0, 160))}\n`,
      );
      break;
    case "result": {
      const [verdict = "", ...rest] = event.text.split("\n");
      process.stdout.write(`  ${verdict.startsWith("OK") ? verdict : amber(verdict)}\n`);

      const body = rest
        .join("\n")
        .replace(/^output:\n?/, "")
        .trim();

      if (body)
        process.stdout.write(
          dim(
            body
              .split("\n")
              .slice(0, 12)
              .map((line) => `  │ ${line}`)
              .join("\n"),
          ) + "\n",
        );
      break;
    }

    case "error":
      process.stdout.write(`  ${amber("tool error")} ${String(event.error)}\n`);
      break;
    default: {
      const exhaustive: never = event;
      throw new Error(`Unhandled event ${JSON.stringify(exhaustive)}`);
    }
  }
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const providerName = parseProviderName(process.env.SANDBOX_PROVIDER);

  const model = cli.dryRun
    ? scriptedModel(dryRunScript(cli.task), "\nDone. Wrote AGENT_NOTES.md.")
    : resolveModel();

  console.log(dim(`sandbox: ${providerName}${cli.keep ? ` (key ${cli.keep})` : ""}`));

  // With a key, disposal detaches and leaves the sandbox running; without one it is destroyed.
  await using box = await createSandbox(await loadProvider(providerName), {
    key: cli.keep,
    labels: { example: "coding-agent" },
  });

  console.log(dim(`${box.created ? "created" : "reused"} ${box.id}`));

  if (!(await box.files.exists(`${repoDir}/.git`))) {
    console.log(dim(`cloning ${cli.repo}`));

    const clone = await box.git.clone(cli.repo, {
      dir: repoDir,
      branch: cli.branch,
      depth: 1,
      token: process.env.GITHUB_TOKEN,
    });

    if (!clone.ok) {
      console.error(clone.output);
      process.exitCode = 1;

      return;
    }
  }

  const checkpoint = await box.files.mark();

  await runAgent({ box, model, task: cli.task, onEvent: print });

  const diff = await box.files.changes({ since: checkpoint });
  console.log(
    `\n\n${amber("changes")} added ${diff.added.length}, modified ${diff.modified.length}, removed ${diff.removed.length}`,
  );
  console.log(diff.patch || dim("(no changes)"));

  if (cli.keep) console.log(dim(`sandbox kept as "${cli.keep}" (${box.id})`));
}

await main();
