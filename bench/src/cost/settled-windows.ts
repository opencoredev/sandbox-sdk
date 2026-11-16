/**
 * Whether one realistic run held a provider account to itself for a whole settlement window, and
 * what the provider charged for that window: the evidence behind a "reconciled" entry in the
 * settled-charge audit (audit-file.ts). These functions only read evidence the scripts fetched
 * (bench/scripts/boxd-settled.ts, e2b-settled.ts); they never decide eligibility, which stays in
 * eligibility.ts with its 10% rule.
 *
 * - boxd posts one org-wide usage charge per 15-minute bucket, about 10 minutes after it closes.
 * - E2B's console reports usage per UTC hour, booking each execution segment in the hour it ended.
 *
 * Isolation is strict: every bucket from the one before the run to the one after it must show no
 * machine or sandbox but the run's own, and the buckets on either side must be empty, so nothing
 * the run did can sit outside the window and nothing else can sit inside it.
 */

export interface RunAttempt {
  readonly attemptId: string;
  readonly sandboxIds: readonly string[];
  readonly startedAt: number;
  readonly endedAt: number;
  readonly deletionConfirmed: boolean;
}

export type SettledWindow =
  | {
      readonly kind: "isolated";
      readonly period: { readonly start: string; readonly end: string };
      readonly settledUSD: number;
      readonly isolation: string;
    }
  | { readonly kind: "not-isolated"; readonly reasons: readonly [string, ...string[]] };

const iso = (ms: number) => new Date(ms).toISOString();

type Isolated = Omit<Extract<SettledWindow, { kind: "isolated" }>, "kind">;

/** Isolated only when no check failed; `ok` runs only then. */
function verdict(reasons: readonly string[], ok: () => Isolated): SettledWindow {
  const [first, ...rest] = reasons;

  return first === undefined
    ? { kind: "isolated", ...ok() }
    : { kind: "not-isolated", reasons: [first, ...rest] };
}

/** Every attempt that made a sandbox must have had its deletion confirmed. */
function deletionProblems(attempts: readonly RunAttempt[]): string[] {
  return attempts.flatMap((a) =>
    a.sandboxIds.length > 0 && !a.deletionConfirmed
      ? [`attempt ${a.attemptId} has no confirmed deletion`]
      : [],
  );
}

const noSandbox: SettledWindow = { kind: "not-isolated", reasons: ["the run created no sandbox"] };

export const BOXD_BUCKET_MS = 15 * 60_000;

/** One 15-minute boxd usage bucket: each machine's amount at boxd's rates, in micro-USD. */
export interface BoxdBucket {
  readonly start: number;
  readonly complete: boolean;
  readonly machines: readonly {
    readonly machineId: string;
    readonly micro: number;
    /** boxd's own state for the machine as of the reading, such as "running" or "deleted". */
    readonly status: string;
  }[];
}

export interface BoxdLedgerEntry {
  readonly kind: string;
  readonly amountMicro: number;
  readonly createdAt: number;
}

/** A bucket's charge posts between 5 and 20 minutes after it closes (providers.ts readBoxdCharges). */
const BOXD_POST_FROM_MS = 5 * 60_000;
const BOXD_POST_UNTIL_MS = 20 * 60_000;

/** The 2 micro-USD readBoxdCharges allows; of 53 buckets read on 2026-11-16 none was charged more than 1 below its usage. */
const BOXD_SHORTFALL_MICRO = 2;

/** The 15-minute buckets the run's machines were metered in, until the bucket after the last delete lands. */
export function boxdPeriod(attempts: readonly RunAttempt[]) {
  const used = attempts.filter((a) => a.sandboxIds.length > 0);
  const first = Math.min(...used.map((a) => a.startedAt));
  const last = Math.max(...used.map((a) => a.endedAt));
  const start = Math.floor(first / BOXD_BUCKET_MS) * BOXD_BUCKET_MS;
  // Machines are metered until deletion lands, so a delete in a bucket's last minute reaches the next.
  const end = (Math.floor((last + 60_000) / BOXD_BUCKET_MS) + 1) * BOXD_BUCKET_MS;

  return { start, end };
}

/**
 * The org's posted charge for the run's buckets, when the org had nothing else in them. `buckets`
 * must cover the bucket before the period through the bucket after it; `ledger` every billing
 * activity entry from the period's start through 20 minutes after the bucket after it closed.
 */
export function boxdWindow(input: {
  readonly attempts: readonly RunAttempt[];
  readonly buckets: readonly BoxdBucket[];
  readonly ledger: readonly BoxdLedgerEntry[];
  readonly readAt: number;
}): SettledWindow {
  if (!input.attempts.some((a) => a.sandboxIds.length > 0)) return noSandbox;

  // boxd's usage reports each machine's state: "deleted" is the provider confirming the deletion
  // the harness records, so an attempt whose delete call didn't return can still have it.
  const deleted = new Set(
    input.buckets.flatMap((b) =>
      b.machines.filter((m) => m.status === "deleted").map((m) => m.machineId),
    ),
  );

  const reasons = deletionProblems(
    input.attempts.map((a) =>
      a.deletionConfirmed ||
      a.sandboxIds.length === 0 ||
      !a.sandboxIds.every((id) => deleted.has(id))
        ? a
        : { ...a, deletionConfirmed: true },
    ),
  );

  const { start, end } = boxdPeriod(input.attempts);
  const ours = new Set(input.attempts.flatMap((a) => a.sandboxIds));
  const seen = new Set<string>();
  const before = start - BOXD_BUCKET_MS;
  const after = end;

  // A bucket's charge posts 5 to 20 minutes after it closes; consecutive buckets' posting windows
  // don't overlap, so each charge belongs to exactly one bucket.
  const postedFor = (at: number) =>
    input.ledger.filter(
      (e) =>
        e.kind === "usage_charge" &&
        e.createdAt >= at + BOXD_BUCKET_MS + BOXD_POST_FROM_MS &&
        e.createdAt < at + BOXD_BUCKET_MS + BOXD_POST_UNTIL_MS,
    );

  let settledMicro = 0;
  let charges = 0;

  for (let at = before; at <= after; at += BOXD_BUCKET_MS) {
    const bucket = input.buckets.find((b) => b.start === at);
    const label = iso(at);
    const posted = postedFor(at);

    if (bucket === undefined) {
      reasons.push(`bucket ${label} was not read`);
      continue;
    }

    if (!bucket.complete) reasons.push(`bucket ${label} is still metering`);
    let metered = 0;

    for (const m of bucket.machines) {
      if (m.micro <= 0) continue;
      metered += m.micro;

      if (at === before || at === after)
        reasons.push(`machine ${m.machineId} was metered in ${label}, outside the run's buckets`);
      else if (!ours.has(m.machineId))
        reasons.push(`machine ${m.machineId}, not the run's, was metered in ${label}`);
      else seen.add(m.machineId);
    }

    // A metered bucket has exactly one charge and an empty one none, so none is missing or extra.
    if (metered > 0 && posted.length !== 1)
      reasons.push(`bucket ${label} was metered but has ${posted.length} usage charges, not 1`);

    if (metered === 0 && posted.length > 0)
      reasons.push(`bucket ${label} metered nothing but has ${posted.length} usage charges`);

    // A charge below the bucket's metered amount means part of it isn't charged. Buckets where
    // machines start and stop are charged up to 50 micro-USD more, so only a shortfall is refused.
    const charged = posted.reduce((sum, e) => sum - e.amountMicro, 0);

    if (metered > 0 && posted.length === 1 && charged < metered - BOXD_SHORTFALL_MICRO)
      reasons.push(`bucket ${label} metered ${metered} micro-USD but was charged ${charged}`);

    if (at !== before && at !== after)
      for (const e of posted) {
        settledMicro -= e.amountMicro;
        charges++;
      }
  }

  for (const id of ours) if (!seen.has(id)) reasons.push(`machine ${id} is absent from usage`);

  const other = input.ledger.filter(
    (e) =>
      e.kind !== "usage_charge" &&
      e.createdAt >= before + BOXD_BUCKET_MS + BOXD_POST_FROM_MS &&
      e.createdAt < after + BOXD_BUCKET_MS + BOXD_POST_UNTIL_MS,
  );

  for (const e of other)
    reasons.push(`a ${e.kind} entry of ${e.amountMicro} micro-USD posted at ${iso(e.createdAt)}`);

  if (input.readAt < after + BOXD_BUCKET_MS + BOXD_POST_UNTIL_MS)
    reasons.push(`read at ${iso(input.readAt)}, before the bucket after the run could post`);

  return verdict(reasons, () => ({
    period: { start: iso(start), end: iso(end) },
    settledUSD: settledMicro / 1e6,
    isolation: `boxd orgs.usage per 15-minute bucket from ${iso(before)} to ${iso(after + BOXD_BUCKET_MS)} meters only the run's ${ours.size} machines, all inside ${iso(start)} to ${iso(end)}, with the buckets on either side empty; each metered bucket has exactly one usage_charge (${charges} in all) and the buckets on either side none`,
  }));
}

export const HOUR_MS = 3_600_000;

/** One hour of the E2B console's usage (projects.getUsage, grain "hour"). */
export interface E2bHour {
  readonly start: number;
  readonly sandboxCount: number;
  readonly cpuHours: number;
  readonly ramGibHours: number;
  readonly usd: number;
}

/** One lifecycle event from E2B's team-wide event list (GET /events/sandboxes). */
export interface E2bEvent {
  readonly sandboxId: string;
  readonly teamId: string;
  readonly type: string;
  readonly timestamp: number;
  /** E2B's sandboxExecutionId: an opener and the close that ends its segment share it. */
  readonly executionId: string | null;
  /** The segment a paused or killed event closes, as E2B metered it. */
  readonly execution: {
    readonly startedAt: number | null;
    readonly executionMs: number;
    readonly vcpu: number;
    readonly memoryMb: number;
  } | null;
}

/** One reading of the console's hourly usage, and the interval it asked for. */
export interface E2bReading {
  readonly projectId: string;
  readonly from: number;
  readonly to: number;
  readonly fetchedAt: number;
  /** Hours with no usage are absent. */
  readonly hours: readonly E2bHour[];
}

const closes = new Set(["sandbox.lifecycle.paused", "sandbox.lifecycle.killed"]);

/**
 * When a sandbox may have been executing, from its lifecycle events, read conservatively. Until a
 * created event says it began, its state before the list's first event is unknown and counts as
 * executing. Created or resumed opens an execution, paused or killed closes it. A close that finds
 * the sandbox already closed (its resume is missing) counts as executing since the previous close.
 * A close's metered segment (start, or end minus duration) moves the opening earlier if it is. An
 * execution still open, or a state still unknown, at the end runs to Infinity.
 */
export function executions(events: readonly E2bEvent[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];

  let state:
    | { kind: "unknown" }
    | { kind: "open"; since: number }
    | { kind: "closed"; at: number } = { kind: "unknown" };

  for (const e of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
    if (e.type === "sandbox.lifecycle.created") state = { kind: "open", since: e.timestamp };
    else if (e.type === "sandbox.lifecycle.resumed" && state.kind === "closed")
      state = { kind: "open", since: e.timestamp };
    else if (closes.has(e.type)) {
      const since =
        state.kind === "open" ? state.since : state.kind === "unknown" ? -Infinity : state.at;

      const metered = Math.min(
        e.execution?.startedAt ?? Infinity,
        e.timestamp - (e.execution?.executionMs ?? 0),
      );

      out.push({ start: Math.min(since, metered), end: e.timestamp });
      state = { kind: "closed", at: e.timestamp };
    }
  }

  if (state.kind === "open") out.push({ start: state.since, end: Infinity });

  if (state.kind === "unknown") out.push({ start: -Infinity, end: Infinity });

  return out;
}

/** How far a segment's meter may sit from its own events: observed under 30 ms in 99% of 4,082. */
const E2B_SEGMENT_TOLERANCE_MS = 2_000;

/**
 * Why one of the run's sandboxes has a lifecycle that doesn't account for all of its execution:
 * it must be created, then alternate closes and resumes and end killed, and each close's metered
 * segment must start and last as its own open and close events say, so no segment is missing.
 */
function lifecycleProblems(id: string, events: readonly E2bEvent[]): string[] {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const problems: string[] = [];
  let open: number | null = null;
  let openId: string | null = null;
  const openers = new Set<string>();
  let killed = false;

  for (const [index, e] of sorted.entries()) {
    if (index === 0 && e.type !== "sandbox.lifecycle.created")
      problems.push(`sandbox ${id}'s history doesn't start with its creation`);

    if (killed) problems.push(`sandbox ${id} has a ${e.type} after it was killed`);

    if (e.type === "sandbox.lifecycle.created" || e.type === "sandbox.lifecycle.resumed") {
      if (open !== null)
        problems.push(`sandbox ${id} opens at ${iso(e.timestamp)} while already open`);

      // Each segment has its own execution ID, so a close carrying another one means a pause and
      // resume between them are missing, however short.
      if (e.executionId === null || openers.has(e.executionId))
        problems.push(`sandbox ${id}'s opening at ${iso(e.timestamp)} has no new execution ID`);
      else openers.add(e.executionId);
      open = e.timestamp;
      openId = e.executionId;
    } else if (closes.has(e.type)) {
      const x = e.execution;

      if (open === null)
        problems.push(`sandbox ${id} closes at ${iso(e.timestamp)} while not open`);
      else if (e.executionId === null || e.executionId !== openId)
        problems.push(
          `sandbox ${id}'s close at ${iso(e.timestamp)} is of execution ${e.executionId}, not the one opened, ${openId}`,
        );
      else if (x === null)
        problems.push(`sandbox ${id}'s close at ${iso(e.timestamp)} has no meter`);
      else if (
        Math.abs(e.timestamp - open - x.executionMs) > E2B_SEGMENT_TOLERANCE_MS ||
        (x.startedAt !== null && Math.abs(x.startedAt - open) > E2B_SEGMENT_TOLERANCE_MS)
      )
        problems.push(
          `sandbox ${id}'s segment closing at ${iso(e.timestamp)} is metered for ${x.executionMs} ms, but its events span ${e.timestamp - open} ms`,
        );

      open = null;
      killed = e.type === "sandbox.lifecycle.killed";
    }
  }

  if (!killed) problems.push(`sandbox ${id} has no killed event`);

  return problems;
}

/**
 * Hourly quantities may differ from the events' segments by rounding: under 0.00005 hours in the
 * 2026-11-05 hours that held only the run's sandboxes. Never more than half the hour's smallest
 * segment, so a whole segment can't be missing within it.
 */
const E2B_QUANTITY_TOLERANCE_HOURS = 0.001;

/**
 * The team's console charge for the whole UTC hours the run's sandboxes ended segments in, when no
 * other sandbox of the team executed at any time from the hour before through the hour after.
 * `events` is the team's whole lifecycle event list. `reading` and `recheck` are two readings of
 * the console's hourly usage for the API key's team, each covering the hour before through the
 * hour after, the second at least 30 minutes after the first; every hour of the period must agree
 * between them, so the figure has stopped moving.
 */
export function e2bWindow(input: {
  readonly attempts: readonly RunAttempt[];
  readonly events: readonly E2bEvent[];
  readonly eventsComplete: boolean;
  readonly reading: E2bReading;
  readonly recheck: E2bReading;
}): SettledWindow {
  if (!input.attempts.some((a) => a.sandboxIds.length > 0)) return noSandbox;
  const reasons = deletionProblems(input.attempts);

  const ours = new Set(input.attempts.flatMap((a) => a.sandboxIds));
  const own = input.events.filter((e) => ours.has(e.sandboxId));
  const used = input.attempts.filter((a) => a.sandboxIds.length > 0);
  const first = Math.min(...used.map((a) => a.startedAt), ...own.map((e) => e.timestamp));
  const last = Math.max(...used.map((a) => a.endedAt), ...own.map((e) => e.timestamp));
  const start = Math.floor(first / HOUR_MS) * HOUR_MS;
  const end = (Math.floor(last / HOUR_MS) + 1) * HOUR_MS;
  const before = start - HOUR_MS;
  const after = end + HOUR_MS;

  if (!input.eventsComplete) reasons.push("the team's event list was not read to its end");

  // The console must be the API key's team: the events are the key's, and name their team.
  for (const team of new Set(input.events.map((e) => e.teamId)))
    for (const r of [input.reading, input.recheck])
      if (team !== r.projectId)
        reasons.push(
          `the events are of team ${team}, the console reading of project ${r.projectId}`,
        );

  for (const id of ours)
    reasons.push(
      ...lifecycleProblems(
        id,
        own.filter((e) => e.sandboxId === id),
      ),
    );

  const bySandbox = new Map<string, E2bEvent[]>();

  for (const e of input.events)
    if (!ours.has(e.sandboxId))
      bySandbox.set(e.sandboxId, [...(bySandbox.get(e.sandboxId) ?? []), e]);

  for (const [id, events] of bySandbox)
    if (executions(events).some((x) => x.start < after && x.end >= before))
      reasons.push(
        `sandbox ${id}, not the run's, was executing between ${iso(before)} and ${iso(after)}`,
      );

  for (const { label, r } of [
    { label: "first", r: input.reading },
    { label: "second", r: input.recheck },
  ]) {
    if (r.from > before || r.to < after)
      reasons.push(`the ${label} console reading doesn't cover ${iso(before)} to ${iso(after)}`);

    if (r.fetchedAt < after)
      reasons.push(`the ${label} console reading was taken before ${iso(after)}`);

    for (const h of r.hours)
      if ((h.start >= before && h.start < start) || (h.start >= end && h.start < after))
        reasons.push(
          `the ${label} console reading shows usage in ${iso(h.start)}, outside the run`,
        );
  }

  if (input.recheck.fetchedAt - input.reading.fetchedAt < 30 * 60_000)
    reasons.push("the console's usage was not read again at least 30 minutes later");

  const inPeriod = (hours: readonly E2bHour[]) =>
    hours.filter((h) => h.start >= start && h.start < end).sort((a, b) => a.start - b.start);

  const now = inPeriod(input.reading.hours);

  if (JSON.stringify(now) !== JSON.stringify(inPeriod(input.recheck.hours)))
    reasons.push("the console's hourly usage for the period changed between the two readings");

  // A segment is booked in the hour it ended, and only the run's sandboxes executed, so every hour
  // the run ended segments in must be there with those sandboxes and those segments' quantities,
  // and no other hour: a segment whose charge hasn't posted shows as missing vCPU and RAM hours.
  for (let at = start; at < end; at += HOUR_MS) {
    const segments = own.filter(
      (e) => closes.has(e.type) && e.timestamp >= at && e.timestamp < at + HOUR_MS,
    );

    for (const e of segments)
      if (e.execution === null)
        reasons.push(
          `sandbox ${e.sandboxId}'s ${e.type} at ${iso(e.timestamp)} has no execution meter`,
        );

    const cpuHours = segments.reduce(
      (sum, e) => sum + ((e.execution?.executionMs ?? 0) / HOUR_MS) * (e.execution?.vcpu ?? 0),
      0,
    );

    const ramGibHours = segments.reduce(
      (sum, e) =>
        sum + ((e.execution?.executionMs ?? 0) / HOUR_MS) * ((e.execution?.memoryMb ?? 0) / 1024),
      0,
    );

    const ended = new Set(segments.map((e) => e.sandboxId)).size;
    const shown = now.find((h) => h.start === at);

    if (ended !== (shown?.sandboxCount ?? 0))
      reasons.push(
        `the console counts ${shown?.sandboxCount ?? 0} sandboxes in ${iso(at)}; the run ended segments of ${ended}`,
      );

    const quantities = segments.map((e) => ({
      cpu: ((e.execution?.executionMs ?? 0) / HOUR_MS) * (e.execution?.vcpu ?? 0),
      ram: ((e.execution?.executionMs ?? 0) / HOUR_MS) * ((e.execution?.memoryMb ?? 0) / 1024),
    }));

    const cpuTolerance = Math.min(
      E2B_QUANTITY_TOLERANCE_HOURS,
      ...quantities.map((q) => q.cpu / 2),
    );

    const ramTolerance = Math.min(
      E2B_QUANTITY_TOLERANCE_HOURS,
      ...quantities.map((q) => q.ram / 2),
    );

    if (
      Math.abs(cpuHours - (shown?.cpuHours ?? 0)) > cpuTolerance ||
      Math.abs(ramGibHours - (shown?.ramGibHours ?? 0)) > ramTolerance
    )
      reasons.push(
        `the console has ${shown?.cpuHours ?? 0} vCPU and ${shown?.ramGibHours ?? 0} GiB hours in ${iso(at)}; the run's segments ending then had ${cpuHours} and ${ramGibHours}`,
      );
  }

  return verdict(reasons, () => ({
    period: { start: iso(start), end: iso(end) },
    settledUSD: now.reduce((sum, h) => sum + h.usd, 0),
    isolation: `E2B's team-wide lifecycle events show no sandbox but the run's ${ours.size} executing from ${iso(before)} to ${iso(after)}; two console readings of the key's team, ${Math.round((input.recheck.fetchedAt - input.reading.fetchedAt) / 60_000)} minutes apart, show nothing in ${iso(before)} or ${iso(end)}, the same figures for the period, and for each hour of it the run's sandboxes that ended a segment then and those segments' vCPU and RAM hours`,
  }));
}
