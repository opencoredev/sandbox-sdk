/**
 * Parsers for Styne's REST answers (https://docs.styne.ai, https://api.styne.ai/openapi.json), each
 * checked against live answers on 2026-11-23. Every parser takes parsed JSON and returns only the
 * fields the adapter uses; access tokens never leave the connection record.
 */
import type { Labels, SandboxInfo } from "../../provider.js";
import { isJsonObject, type JsonValue } from "../../shared/json.js";
import { isNumber, isString } from "../../shared/narrow.js";
import { fail } from "./errors.js";

/** The metadata entry that carries the SDK's sandbox key. */
export const keyLabel = "sandbox-sdk-key";

const field = (raw: JsonValue | undefined, key: string): JsonValue | undefined =>
  isJsonObject(raw) ? raw[key] : undefined;

function labelsOf(raw: JsonValue | undefined): Labels {
  const labels: Labels = {};

  if (isJsonObject(raw))
    for (const [key, value] of Object.entries(raw)) if (isString(value)) labels[key] = value;

  return labels;
}

/** `GET /sandboxes/{id}` and each entry of `GET /sandboxes`. */
export interface StyneSandbox {
  id: string;
  state: string;
  metadata: Labels;
  startedAt: number;
  domain: string | undefined;
}

export function parseSandbox(raw: JsonValue | undefined): StyneSandbox {
  const id = field(raw, "sandboxID");
  const state = field(raw, "state");

  if (!isString(id) || !isString(state)) throw fail("unexpected sandbox object from the API");
  const started = field(raw, "startedAt");
  const startedAt = isString(started) ? Date.parse(started) : Number.NaN;
  const domain = field(raw, "domain");

  return {
    id,
    state,
    metadata: labelsOf(field(raw, "metadata")),
    startedAt: Number.isFinite(startedAt) ? startedAt : 0,
    domain: isString(domain) ? domain : undefined,
  };
}

export function parseSandboxList(raw: JsonValue | undefined): StyneSandbox[] {
  if (!Array.isArray(raw)) throw fail("unexpected sandbox list from the API");

  return raw.map(parseSandbox);
}

/**
 * The answer of a create, a resume and `POST /sandboxes/{id}/connect`: what reaching the sandbox's
 * ports needs. `GET` leaves the traffic token out, so it is read from these.
 */
export interface Connection {
  id: string;
  domain: string;
  trafficAccessToken: string | undefined;
}

export function parseConnection(raw: JsonValue | undefined): Connection {
  const id = field(raw, "sandboxID");
  const domain = field(raw, "domain");

  if (!isString(id) || !id) throw fail("the API answered without a sandbox ID", "outcome_unknown");

  if (!isString(domain) || !/^[a-z0-9.-]{1,253}$/.test(domain))
    throw fail("the API answered without a sandbox domain", "provider", { sandboxId: id });
  const token = field(raw, "trafficAccessToken");

  return { id, domain, trafficAccessToken: isString(token) && token ? token : undefined };
}

/** `POST /sandboxes/{id}/snapshots` and `GET /snapshots/{name}`. */
export interface StyneSnapshot {
  name: string;
  sandboxId: string | undefined;
}

export function parseSnapshot(raw: JsonValue | undefined): StyneSnapshot {
  const name = field(raw, "name");
  const source = field(raw, "sandboxID");

  if (!isString(name)) throw fail("unexpected snapshot object from the API");

  return { name, sandboxId: isString(source) ? source : undefined };
}

/** The SDK's view of a sandbox: the key moves out of the labels, the state to running, paused or stopped. */
export function toInfo(sandbox: StyneSandbox): SandboxInfo {
  const { [keyLabel]: key, ...labels } = sandbox.metadata;

  // A sandbox asleep after its idle time or at a pause tier reads paused; any call wakes the first.
  const state: SandboxInfo["state"] =
    sandbox.state === "running"
      ? "running"
      : ["paused", "sleeping", "standby", "archived"].includes(sandbox.state)
        ? "paused"
        : "stopped";

  return key === undefined
    ? { id: sandbox.id, labels, state, createdAt: sandbox.startedAt }
    : { id: sandbox.id, key, labels, state, createdAt: sandbox.startedAt };
}

/** One line of the `POST /sandboxes/{id}/exec` answer. Unknown lines are skipped. */
export type ExecFrame =
  | { kind: "started"; pid: number }
  | { kind: "output"; stream: "stdout" | "stderr"; data: Uint8Array }
  | { kind: "exit"; exitCode: number; signal: number; timedOut: boolean }
  | { kind: "error"; code: string | undefined }
  | { kind: "other" };

const safeCode = /^[a-z][a-z0-9_]{0,63}$/;

function errorCodeOf(raw: JsonValue | undefined): string | undefined {
  const code = field(raw, "error_code");

  return isString(code) && safeCode.test(code) ? code : undefined;
}

export function parseExecFrame(raw: JsonValue | undefined): ExecFrame {
  if (!isJsonObject(raw)) throw fail("the command stream sent a line that is not an object");

  const started = field(raw, "started");
  const pid = field(started, "pid");

  if (isNumber(pid) && Number.isSafeInteger(pid) && pid > 0) return { kind: "started", pid };

  for (const stream of ["stdout", "stderr"] as const) {
    const data = raw[stream];

    if (isString(data)) return { kind: "output", stream, data: Buffer.from(data, "base64") };
  }

  const exit = raw.exit;

  if (isJsonObject(exit)) {
    const exitCode = exit.exitCode;
    const signal = exit.signal;

    return {
      kind: "exit",
      exitCode: isNumber(exitCode) ? exitCode : -1,
      signal: isNumber(signal) ? signal : 0,
      timedOut: exit.timedOut === true,
    };
  }

  if (raw.error !== undefined) return { kind: "error", code: errorCodeOf(raw.error) };

  return { kind: "other" };
}

/** Styne's metric fields and the shared usage names they become. */
const metricNames = {
  cpuCount: "cpuCount",
  cpuUsedPct: "cpuPercent",
  memUsed: "memoryBytes",
  memTotal: "memoryLimitBytes",
  diskUsed: "diskBytes",
  diskTotal: "diskLimitBytes",
  timestampUnix: "metricsAt",
} as const;

/** The newest `GET /sandboxes/{id}/metrics` sample, under the shared usage names; `metricsAt` in ms. */
export function parseMetrics(raw: JsonValue | undefined) {
  const latest = Array.isArray(raw) ? raw.at(-1) : undefined;

  if (!isJsonObject(latest)) return {};

  return Object.fromEntries(
    Object.entries(metricNames).flatMap(([from, to]) => {
      const value = latest[from];

      if (!isNumber(value) || !Number.isFinite(value)) return [];

      return [[to, from === "timestampUnix" ? value * 1000 : value]];
    }),
  );
}
