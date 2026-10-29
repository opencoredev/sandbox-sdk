import { Readable } from "node:stream";
import type { DownloadStreamOptions, Sandbox } from "@daytonaio/sdk";
import { SandboxError } from "../../errors.js";
import { unloadedModule } from "./errors.js";

// The Daytona SDK uploads with form-data and downloads with busboy, both loaded through a runtime
// require that bundlers cannot follow, so a bundled app fails every transfer. Then the bytes move
// through codeRun instead, which is a plain JSON request. Whether those modules load is fixed for
// the life of the process, so one probe decides.
let native: Promise<boolean> | undefined;

// downloadFiles opens its response before it requires busboy, and a failed require leaves that
// response unread, holding a socket that keeps the process alive. So probe first, with nothing
// sent: uploadFiles loads form-data (the same way as busboy) before building the request, and a
// source path with a NUL byte then fails synchronously in fs.createReadStream.
function nativeTransfers(box: Sandbox): Promise<boolean> {
  return native ??= box.fs.uploadFiles([{ source: "\0", destination: "/tmp/.sandbox-sdk/probe" }])
    .then(() => true, (error: unknown) => unloadedModule(error) === undefined);
}

async function transfer<T>(box: Sandbox, nativeCall: () => Promise<T>, viaCode: () => Promise<T>): Promise<T> {
  if (await nativeTransfers(box)) {
    try { return await nativeCall(); }
    catch (error) { if (unloadedModule(error) === undefined) throw error; native = Promise.resolve(false); }
  }
  return viaCode();
}

/** Writes `data` to the absolute `path`, creating parent directories. */
export function upload(box: Sandbox, data: Uint8Array, path: string): Promise<void> {
  return transfer(box, () => box.fs.uploadFile(Buffer.from(data), path), async () => {
    // Code is a request body, so a large file avoids argv limits.
    const result = await box.process.codeRun(`import os,base64
p=${JSON.stringify(path)}
os.makedirs(os.path.dirname(p) or "/",exist_ok=True)
with open(p,"wb") as f: f.write(base64.b64decode(${JSON.stringify(Buffer.from(data).toString("base64"))}))`, undefined, 120);
    if (result.exitCode !== 0) throw new SandboxError("File upload failed. The native code operation failed. Check the path and guest permissions.", { code: "provider", provider: "daytona", sandboxId: box.id });
  });
}

/** Reads the absolute `path`. A missing file is a `file_not_found` SandboxError on the fallback path. */
export function download(box: Sandbox, path: string): Promise<Uint8Array> {
  return transfer(box, async () => new Uint8Array(await box.fs.downloadFile(path)), async () => {
    const result = await box.process.codeRun(`import base64
try: d=open(${JSON.stringify(path)},"rb").read()
except FileNotFoundError: print("SDK_FILE_NOT_FOUND")
else: print("SDK_FILE:"+base64.b64encode(d).decode())`, undefined, 120);
    const line = result.result.split("\n").map(text => text.trim()).find(text => text.startsWith("SDK_FILE"));
    if (line === "SDK_FILE_NOT_FOUND") throw new SandboxError("File does not exist. Check the path.", { code: "file_not_found", provider: "daytona", sandboxId: box.id });
    if (result.exitCode !== 0 || !line?.startsWith("SDK_FILE:")) throw new SandboxError("File download failed. The native code operation failed. Check the path and guest permissions.", { code: "provider", provider: "daytona", sandboxId: box.id });
    return new Uint8Array(Buffer.from(line.slice("SDK_FILE:".length), "base64"));
  });
}

/** Streams the absolute `path`. The fallback reads the whole file, then streams it from memory. */
export function downloadStream(box: Sandbox, path: string, options: DownloadStreamOptions): Promise<Readable> {
  return transfer(box, () => box.fs.downloadFileStream(path, options), async () => Readable.from([await download(box, path)]));
}

/** @internal Restores native transfers between tests. */
export function resetTransfers() { native = undefined; }
