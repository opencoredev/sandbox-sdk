/** Official HTTP transport mock. The real Boat SDK talks to this server; files,
 * commands, stdin, streaming, process groups and preview HTTP run on real Linux.
 */
import { createServer, type ServerResponse } from "node:http";
import { createServer as createSocket } from "node:net";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const bodySchema = z
  .object({
    command: z.string().optional(),
    detached: z.boolean().optional(),
    name: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    noEnv: z.boolean().optional(),
    type: z.string().optional(),
    port: z.number().optional(),
    path: z.string().optional(),
    content: z.string().optional(),
    encoding: z.enum(["utf8", "base64"]).optional(),
  })
  .passthrough();

type Chunk = { type: "stdout" | "stderr"; data: string };

type Command = {
  processId: number;
  chunks: Chunk[];
  listeners: Set<ServerResponse>;
  done: Promise<void>;
  exitCode: number | null;
  finished: boolean;
};

type Box = {
  id: string;
  name: string;
  root: string;
  port: number;
  env: Record<string, string>;
  createdAt: string;
  state: string;
  region?: string;
  commands: Map<number, Command>;
};

export async function boatMock(provider: "boat" | "sandboxer" = "boat") {
  const snapshots = new Map<string, { name: string; sourceSandboxId: string; status: string }>();
  const operations = new Map<string, string>();
  const deletions = new Map<string, string>();
  let staleRename = false;
  const boxes = new Map<string, Box>();
  const creates: unknown[] = [];
  const calls: string[] = [];
  const commands: string[] = [];
  const fileWrites: { path: string; mode: number; directoryMode: number }[] = [];
  let status = 0;
  let launchDelayMs = 0;
  let failStream = false;
  let failSetup = false;
  let truncate = false;
  let loseCreate = false;
  let loseWrite = false;
  const idempotent = new Map<string, Box>();

  const json = (res: ServerResponse, data: unknown, statusCode = 200) => {
    res.writeHead(statusCode, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };

  const sandbox = (box: Box) => ({
    id: box.id,
    name: box.name,
    state: box.state,
    createdAt: box.createdAt,
    desktopAvailable: false,
    snapshotAvailable: false,
    ...(provider === "sandboxer"
      ? { region: box.region ?? "us-east", regionSource: box.region ? "requested" : "nearest" }
      : {}),
    ...(operations.has(box.id)
      ? { stop: { id: "stop-test", status: operations.get(box.id) } }
      : {}),
  });

  const rewrite = (box: Box, text: string) =>
    text
      .replace(/sudo mkdir /g, failSetup ? "false && mkdir " : "mkdir ")
      .replace(/sudo chown /g, "chown ")
      .replace(/\/workspace|\/tmp\/\.sandbox-sdk|\/tmp\/sdk-bare/g, (path) => join(box.root, path))
      .replace(/\.listen\(3000/g, `.listen(${box.port}`);

  function run(box: Box, command: string): Command {
    const child = spawn("sh", ["-c", rewrite(box, command)], {
      cwd: box.root,
      env: { ...process.env, ...box.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    if (!child.pid) throw new Error("No test PID");

    const entry: Command = {
      processId: child.pid,
      chunks: [],
      listeners: new Set(),
      done: Promise.resolve(),
      exitCode: null,
      finished: false,
    };

    const emit = (type: Chunk["type"], data: Buffer) => {
      const chunk = { type, data: data.toString().split(box.root).join("") };
      entry.chunks.push(chunk);

      for (const res of entry.listeners) res.write(JSON.stringify(chunk) + "\n");
    };

    child.stdout.on("data", (data) => emit("stdout", data));
    child.stderr.on("data", (data) => emit("stderr", data));
    entry.done = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        entry.exitCode = code ?? 137;
        entry.finished = true;

        for (const res of entry.listeners)
          res.end(JSON.stringify({ type: "exit", exitCode: entry.exitCode }) + "\n");
        entry.listeners.clear();
        resolve();
      });
    });
    box.commands.set(child.pid, entry);

    return entry;
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://test");
      calls.push(`${req.method} ${url.pathname}`);

      if (status) {
        json(res, { ok: false, message: "secret-value" }, status);

        return;
      }

      const parts = url.pathname.split("/").filter(Boolean);
      const chunks = [];

      for await (const chunk of req) chunks.push(Buffer.from(chunk));

      const body = bodySchema.parse(
        chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {},
      );

      if (parts.length === 1 && parts[0] === "sandboxes") {
        if (req.method === "POST") {
          const key = String(req.headers["idempotency-key"] ?? "");
          const previous = idempotent.get(key);

          if (previous) {
            json(
              res,
              {
                ok: true,
                type: "sandbox.created",
                status: "ready",
                ttlSeconds: 3600,
                sandbox: sandbox(previous),
              },
              202,
            );

            return;
          }

          creates.push(body);
          const socket = createSocket();
          await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
          const address = socket.address();

          if (!address || typeof address === "string") throw new Error("No port");
          await new Promise<void>((resolve) => socket.close(() => resolve()));

          const box: Box = {
            id: `bx_${crypto.randomUUID()}`,
            name: "Boat test",
            root: await fs.mkdtemp(join(tmpdir(), "sdk-boat-")),
            port: address.port,
            env: body.env ?? {},
            createdAt: new Date().toISOString(),
            state: "idle",
            ...(typeof body.region === "string" ? { region: body.region } : {}),
            commands: new Map(),
          };

          await fs.mkdir(join(box.root, "tmp"), { recursive: true });
          boxes.set(box.id, box);
          idempotent.set(key, box);

          if (loseCreate) {
            loseCreate = false;
            req.socket.destroy();

            return;
          }

          json(
            res,
            {
              ok: true,
              type: "sandbox.created",
              status: "ready",
              ttlSeconds: 3600,
              sandbox: sandbox(box),
            },
            202,
          );

          return;
        }

        // One item per page exercises cursor traversal on every list.
        const all = [...boxes.values()];
        const offset = Number(url.searchParams.get("cursor") ?? 0);
        json(res, {
          ok: true,
          type: "sandbox.list",
          sandboxes: all.slice(offset, offset + 1).map(sandbox),
          pageInfo: { hasMore: offset + 1 < all.length, nextCursor: String(offset + 1), limit: 1 },
        });

        return;
      }

      if (provider === "sandboxer" && parts[0] === "named-snapshots") {
        if (req.method === "POST") {
          const name = z.string().parse(body.name),
            sourceSandboxId = z.string().parse(body.sandboxId);

          const snapshot = { name, sourceSandboxId, status: "ready" };
          snapshots.set(name, snapshot);
          json(res, { ok: true, snapshot }, 202);

          return;
        }

        const name = parts[1];

        if (!name) {
          json(res, { snapshots: [...snapshots.values()] });

          return;
        }

        const snapshot = snapshots.get(name);

        if (!snapshot) {
          json(res, { ok: false }, 404);

          return;
        }

        if (req.method === "DELETE") snapshots.delete(name);
        json(res, { ok: true, snapshot });

        return;
      }

      if (provider === "sandboxer" && parts[0] === "deletion-operations") {
        json(res, {
          operation: {
            id: parts[1],
            targetId: deletions.get(parts[1] ?? ""),
            kind: "sandbox",
            status: "completed",
          },
        });

        return;
      }

      const id = parts[1];
      const box = id ? boxes.get(id) : undefined;

      if (!box) {
        json(res, { ok: false, code: "not_found" }, 404);

        return;
      }

      if (parts.length === 2) {
        if (req.method === "PATCH") box.name = body.name ?? box.name;

        if (req.method === "DELETE") {
          if (
            req.headers[
              provider === "sandboxer" ? "x-sandboxer-confirm-delete" : "x-ascii-confirm-delete"
            ] !== box.id
          )
            throw new Error("Missing deletion confirmation");

          for (const entry of box.commands.values()) {
            try {
              process.kill(-entry.processId, "SIGKILL");
            } catch {}
          }

          await Promise.all([...box.commands.values()].map((entry) => entry.done));
          await fs.rm(box.root, { recursive: true, force: true });
          boxes.delete(box.id);

          if (provider === "sandboxer") deletions.set(`delete-${box.id}`, box.id);
          json(
            res,
            {
              ok: true,
              type: "sandbox.deleting",
              operation: {
                id: provider === "sandboxer" ? `delete-${box.id}` : "delete",
                kind: "sandbox",
                targetId: box.id,
                reason: "explicit",
                status: provider === "sandboxer" ? "processing" : "completed",
                attemptCount: 1,
                requestedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
              },
            },
            202,
          );

          return;
        }

        json(res, {
          ok: true,
          type: "sandbox.info",
          sandbox: {
            ...sandbox(box),
            ...(req.method === "PATCH" && staleRename ? { state: "provisioning" } : {}),
          },
        });

        return;
      }

      if (provider === "sandboxer" && parts[2] === "stop") {
        operations.set(box.id, "completed");
        box.state = "archived";
        json(res, { ok: true, sandbox: sandbox(box) }, 202);

        return;
      }

      if (provider === "sandboxer" && parts[2] === "resume") {
        box.state = "ready";
        json(res, { ok: true, sandbox: sandbox(box) }, 202);

        return;
      }

      if (provider === "sandboxer" && parts[2] === "artifacts") {
        const path = url.searchParams.get("path") ?? "";

        if (!path.startsWith("/tmp/")) throw new Error("Artifact path restriction");

        if ((await fs.stat(join(box.root, path, ".."))).mode % 512 !== 0o700)
          throw new Error("Artifact staging is not private");
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(await fs.readFile(join(box.root, path)));

        return;
      }

      if (provider === "sandboxer" && parts[2] === "files" && parts.length > 3) {
        json(res, { ok: false }, 404);

        return;
      }

      if (parts[2] === "files" && parts[3] === "download-url" && req.method === "POST") {
        if (!body.path?.startsWith("/tmp/")) throw new Error("Signed download path restriction");
        const file = join(box.root, body.path);

        if ((await fs.stat(join(file, ".."))).mode % 512 !== 0o700)
          throw new Error("Download staging is not private");
        json(res, {
          ok: true,
          type: "file.download_url",
          url: `http://${req.headers.host}/sandboxes/${id}/download?path=${encodeURIComponent(body.path)}`,
          method: "GET",
          path: body.path,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        });

        return;
      }

      if (parts[2] === "download" && req.method === "GET") {
        if (req.headers.authorization) throw new Error("Account auth leaked to signed download");
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(await fs.readFile(join(box.root, url.searchParams.get("path") ?? "")));

        return;
      }

      if (parts[2] === "files" && req.method === "PUT") {
        const path = body.path;

        if (!path) throw new Error("Missing file path");

        const content = Buffer.from(
          body.encoding === "base64" ? (body.content ?? "") : rewrite(box, body.content ?? ""),
          body.encoding ?? "utf8",
        );

        if (content.length > 5 * 1024 * 1024) throw new Error("Boat file API size limit");

        if (!path.startsWith("/tmp/") && !path.startsWith("/home/user/"))
          throw new Error("Boat file API path restriction");
        await fs.mkdir(join(box.root, path, ".."), { recursive: true });
        await fs.writeFile(join(box.root, path), content);
        fileWrites.push({
          path,
          mode: (await fs.stat(join(box.root, path))).mode & 0o777,
          directoryMode: (await fs.stat(join(box.root, path, ".."))).mode & 0o777,
        });

        if (loseWrite) {
          loseWrite = false;
          req.socket.destroy();

          return;
        }

        json(res, {
          ok: true,
          type: "file.written",
          success: true,
          path,
          encoding: body.encoding ?? "utf8",
          size: content.length,
        });

        return;
      }

      if (provider === "sandboxer" && parts[2] === "preview") {
        if (!req.headers.cookie?.includes("sandboxer_test_auth=test-token")) {
          res.writeHead(302, {
            location: `/sandboxes/${id}/preview`,
            "set-cookie": "sandboxer_test_auth=test-token; HttpOnly; Path=/",
          });
          res.end();

          return;
        }

        try {
          const remote = await fetch(`http://127.0.0.1:${box.port}`);
          res.writeHead(remote.status);
          res.end(Buffer.from(await remote.arrayBuffer()));
        } catch {
          res.writeHead(503);
          res.end();
        }

        return;
      }

      if (parts[2] === "host") {
        json(res, {
          ok: true,
          type: "sandbox.hosted",
          url:
            provider === "sandboxer"
              ? `http://${req.headers.host}/sandboxes/${id}/preview?_token=test-token`
              : `http://127.0.0.1:${box.port}/?_token=test-token`,
          port: body.port,
        });

        return;
      }

      if (parts[2] === "commands" && parts.length === 3 && req.method === "POST") {
        commands.push(body.command ?? "");

        if (body.command?.startsWith("sudo mkdir -p /workspace")) {
          await fs.mkdir(join(box.root, "workspace"), { recursive: true });
          json(res, {
            ok: true,
            type: "command.finished",
            timedOut: false,
            success: true,
            stdout: "",
            stderr: "",
            exitCode: 0,
          });

          return;
        }

        if (launchDelayMs && body.detached)
          await new Promise((resolve) => setTimeout(resolve, launchDelayMs));
        const entry = run(box, body.command ?? "");

        if (body.detached)
          json(res, {
            ok: true,
            type: "command.started",
            success: true,
            processId: entry.processId,
            pid: entry.processId,
            command: body.command,
            startedAt: new Date().toISOString(),
          });
        else {
          await entry.done;
          json(res, {
            ok: true,
            type: "command.finished",
            timedOut: false,
            success: entry.exitCode === 0,
            exitCode: entry.exitCode,
            stdout: entry.chunks
              .filter((c) => c.type === "stdout")
              .map((c) => c.data)
              .join("")
              .slice(0, truncate ? 4096 : undefined),
            stdoutTruncated: truncate,
            stderr: entry.chunks
              .filter((c) => c.type === "stderr")
              .map((c) => c.data)
              .join(""),
          });
        }

        return;
      }

      const entry = box.commands.get(Number(parts[3]));

      if (!entry) {
        json(res, { ok: false }, 404);

        return;
      }

      if (req.method === "DELETE") {
        try {
          process.kill(-entry.processId, "SIGKILL");
        } catch {}

        await entry.done;
        json(res, {
          ok: true,
          type: "command.stopped",
          processId: entry.processId,
          running: false,
          signaled: true,
          command: null,
        });

        return;
      }

      if (parts[4] === "stream") {
        if (failStream) {
          json(res, { ok: false }, 503);

          return;
        }

        res.writeHead(200, { "content-type": "application/x-ndjson" });

        for (const chunk of entry.chunks) res.write(JSON.stringify(chunk) + "\n");

        if (entry.finished)
          res.end(JSON.stringify({ type: "exit", exitCode: entry.exitCode }) + "\n");
        else {
          entry.listeners.add(res);
          res.on("close", () => entry.listeners.delete(res));
        }

        return;
      }

      json(res, {
        ok: true,
        type: "command.status",
        success: true,
        processId: entry.processId,
        status: entry.finished ? "exited" : "running",
        running: !entry.finished,
        exitCode: entry.exitCode,
        stdout: "",
        stderr: "",
      });
    } catch (error) {
      json(res, { ok: false, message: String(error) }, 500);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!address || typeof address === "string") throw new Error("Missing test server port");

  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    set staleRename(value: boolean) {
      staleRename = value;
    },
    boxes,
    creates,
    calls,
    commands,
    fileWrites,
    set status(value: number) {
      status = value;
    },
    set launchDelayMs(value: number) {
      launchDelayMs = value;
    },
    set failSetup(value: boolean) {
      failSetup = value;
    },
    set failStream(value: boolean) {
      failStream = value;
    },
    set truncate(value: boolean) {
      truncate = value;
    },
    set loseWrite(value: boolean) {
      loseWrite = value;
    },
    set loseCreate(value: boolean) {
      loseCreate = value;
    },
    async dispose() {
      for (const box of boxes.values()) {
        for (const entry of box.commands.values()) {
          try {
            process.kill(-entry.processId, "SIGKILL");
          } catch {}
        }

        await fs.rm(box.root, { recursive: true, force: true });
      }

      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
