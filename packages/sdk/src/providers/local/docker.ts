import { request } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { SandboxError, type ErrorCode } from "../../errors.js";
import type { OutputChunk } from "../../provider.js";

export const failure = (message: string, code: ErrorCode = "provider") => new SandboxError(`${message}. Docker request failed. Check Docker access and the supplied options.`, { code, provider: "local" });
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("Invalid Docker response");
  return Object.fromEntries(Object.entries(value));
}
export function string(value: unknown): string { if (typeof value !== "string") throw failure("Expected a Docker string"); return value; }
export function number(value: unknown): number { if (typeof value !== "number" || !Number.isFinite(value)) throw failure("Expected a Docker number"); return value; }
export function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw failure("Expected a Docker array"); return value; }
export const encode = encodeURIComponent;
export function parse(text: string): unknown { try { return JSON.parse(text); } catch { throw failure("Malformed Docker JSON response"); } }

/** Docker's eight-byte framing can span arbitrary HTTP/TCP chunks. */
export class Demux {
  private pending = Buffer.alloc(0);
  private readonly stdout = new StringDecoder("utf8");
  private readonly stderr = new StringDecoder("utf8");
  constructor(private readonly emit: (chunk: OutputChunk) => void) {}
  push(data: Buffer) {
    this.pending = Buffer.concat([this.pending, data]);
    while (this.pending.length >= 8) {
      const length = this.pending.readUInt32BE(4);
      if (length > 64 * 1024 * 1024 || ![1, 2].includes(this.pending[0] ?? 0)) throw failure("Invalid Docker exec frame");
      if (this.pending.length < length + 8) return;
      const stream = this.pending[0] === 1 ? "stdout" : "stderr";
      const text = this[stream].write(this.pending.subarray(8, length + 8));
      if (text) this.emit({ stream, text });
      this.pending = this.pending.subarray(length + 8);
    }
  }
  end() {
    if (this.pending.length) throw failure("Truncated Docker exec frame");
    for (const stream of ["stdout", "stderr"] as const) { const text = this[stream].end(); if (text) this.emit({ stream, text }); }
  }
}

export class Docker {
  readonly socketPath: string;
  constructor(host = process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock") {
    if (!host.startsWith("unix://") || !host.slice(7).startsWith("/")) throw failure("DOCKER_HOST must be an absolute unix:// socket URL; remote Docker hosts cannot provide localhost previews", "unsupported");
    this.socketPath = host.slice(7);
  }
  async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const req = request({ socketPath: this.socketPath, path: `/v1.44${path}`, method, headers: { "Content-Type": "application/json" } }, res => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", error => reject(failure(error.message, "unavailable")));
        res.on("end", () => {
          const output = Buffer.concat(chunks);
          if ((res.statusCode ?? 500) >= 400) { reject(failure(output.toString(), res.statusCode === 404 ? "not_found" : res.statusCode === 401 || res.statusCode === 403 ? "auth" : "provider")); return; }
          resolve(output);
        });
      });
      req.setTimeout(600_000, () => req.destroy(failure("Docker API timed out", "timeout")));
      req.on("error", error => reject(error instanceof SandboxError ? error : failure(error.message, "unavailable")));
      req.end(data);
    });
    if (!bytes.length) return undefined;
    // Image pull returns newline-delimited progress, including errors inside HTTP 200.
    if (path.startsWith("/images/create")) {
      for (const line of bytes.toString().trim().split("\n")) { const item = object(parse(line)); if (item.error) throw failure(`Image pull: ${string(item.error)}`); }
      return undefined;
    }
    return parse(bytes.toString());
  }
  async exec(id: string, command: string[], options: { cwd?: string; env?: Record<string, string>; stdin?: string; onChunk(chunk: OutputChunk): void }): Promise<number> {
    const created = object(await this.call("POST", `/containers/${encode(id)}/exec`, { Cmd: command, WorkingDir: options.cwd ?? "/", Env: Object.entries(options.env ?? {}).map(([k, v]) => `${k}=${v}`), AttachStdout: true, AttachStderr: true, AttachStdin: options.stdin !== undefined, Tty: false }));
    const execId = string(created.Id);
    await new Promise<void>((resolve, reject) => {
      const demux = new Demux(options.onChunk);
      const req = request({ socketPath: this.socketPath, path: `/v1.44/exec/${encode(execId)}/start`, method: "POST", headers: { "Content-Type": "application/json", Connection: "Upgrade", Upgrade: "tcp" } });
      const consume = (stream: import("node:stream").Readable) => {
        stream.on("data", (chunk: Buffer) => { try { demux.push(chunk); } catch (error) { stream.destroy(); reject(error); } });
        stream.on("error", error => reject(failure(error.message, "unavailable")));
        stream.on("end", () => { try { demux.end(); resolve(); } catch (error) { reject(error); } });
      };
      req.on("upgrade", (_res, socket, head) => {
        socket.setTimeout(0); consume(socket);
        if (head.length) { try { demux.push(head); } catch (error) { socket.destroy(); reject(error); return; } }
        // A half-close sends EOF to stdin while retaining the output read side.
        socket.end(options.stdin ?? "");
      });
      req.on("response", res => {
        if ((res.statusCode ?? 500) >= 400) { res.resume(); reject(failure(`Exec attach HTTP ${res.statusCode}`)); return; }
        consume(res);
      });
      req.on("error", error => reject(failure(error.message, "unavailable")));
      req.setTimeout(30_000, () => req.destroy(failure("Exec attach timed out", "timeout")));
      req.end(JSON.stringify({ Detach: false, Tty: false }));
    });
    const result = object(await this.call("GET", `/exec/${encode(execId)}/json`));
    if (result.Running) throw failure("Exec attachment ended before the process exited", "outcome_unknown");
    return number(result.ExitCode);
  }
}
