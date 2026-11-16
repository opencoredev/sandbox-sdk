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
  readonly machines: readonly { readonly machineId: string; readonly micro: number }[];
}

export interface BoxdLedgerEntry {
  readonly kind: string;
  readonly amountMicro: number;
  readonly createdAt: number;
}

/** A bucket's charge posts between 5 and 20 minutes after it closes (providers.ts readBoxdCharges). */
const BOXD_POST_FROM_MS = 5 * 60_000;
const BOXD_POST_UNTIL_MS = 20 * 60_000;

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
  const reasons = deletionProblems(input.attempts);

  const { start, end } = boxdPeriod(input.attempts);
  const ours = new Set(input.attempts.flatMap((a) => a.sandboxIds));
  const seen = new Set<string>();
  const before = start - BOXD_BUCKET_MS;
  const after = end;

  for (let at = before; at <= after; at += BOXD_BUCKET_MS) {
    const bucket = input.buckets.find((b) => b.start === at);
    const label = iso(at);

    if (bucket === undefined) {
      reasons.push(`bucket ${label} was not read`);
      continue;
    }

    if (!bucket.complete) reasons.push(`bucket ${label} is still metering`);

    for (const m of bucket.machines) {
      if (m.micro <= 0) continue;

      if (at === before || at === after)
        reasons.push(`machine ${m.machineId} was metered in ${label}, outside the run's buckets`);
      else if (!ours.has(m.machineId))
        reasons.push(`machine ${m.machineId}, not the run's, was metered in ${label}`);
      else seen.add(m.machineId);
    }
  }

  for (const id of ours) if (!seen.has(id)) reasons.push(`machine ${id} is absent from usage`);

  // Every charge for a bucket from the one before through the one after, by posting time.
  const posted = (from: number, until: number) =>
    input.ledger.filter(
      (e) =>
        e.kind === "usage_charge" &&
        e.createdAt >= from + BOXD_BUCKET_MS + BOXD_POST_FROM_MS &&
        e.createdAt < until + BOXD_BUCKET_MS + BOXD_POST_UNTIL_MS,
    );

  if (posted(before, before).length > 0)
    reasons.push(`a usage charge was posted for the bucket before the run, ${iso(before)}`);

  if (posted(after, after).length > 0)
    reasons.push(`a usage charge was posted for the bucket after the run, ${iso(after)}`);

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

  const charges = posted(start, end - BOXD_BUCKET_MS);

  if (charges.length > (end - start) / BOXD_BUCKET_MS)
    reasons.push(`${charges.length} usage charges for ${(end - start) / BOXD_BUCKET_MS} buckets`);

  const settledMicro = charges.reduce((sum, e) => sum - e.amountMicro, 0);

  return verdict(reasons, () => ({
    period: { start: iso(start), end: iso(end) },
    settledUSD: settledMicro / 1e6,
    isolation: `boxd orgs.usage per 15-minute bucket from ${iso(before)} to ${iso(after + BOXD_BUCKET_MS)} meters only the run's ${ours.size} machines, all inside ${iso(start)} to ${iso(end)}, with the buckets on either side empty; ${charges.length} usage_charge entries posted for the period and none for the buckets on either side`,
  }));
}

export const HOUR_MS = 3_600_000;

/** One hour of the E2B console's usage (projects.getUsage, grain "hour"). */
export interface E2bHour {
  readonly start: number;
  readonly sandboxCount: number;
  readonly usd: number;
}

/** One lifecycle event from E2B's team-wide event list (GET /events/sandboxes). */
export interface E2bEvent {
  readonly sandboxId: string;
  readonly type: string;
  readonly timestamp: number;
}

/**
 * The team's console charge for the whole UTC hours the run's sandboxes ended segments in, when the
 * team had no other sandbox from the hour before through the hour after. `hours` is the console's
 * hourly usage for at least that range (hours with no usage are absent); `events` the team's whole
 * event list, newest page included; `hoursRecheck` the same usage read again later, which must
 * agree for every hour of the period, so the figure has stopped moving.
 */
export function e2bWindow(input: {
  readonly attempts: readonly RunAttempt[];
  readonly hours: readonly E2bHour[];
  readonly hoursRecheck: readonly E2bHour[];
  readonly recheckGapMs: number;
  readonly events: readonly E2bEvent[];
  readonly eventsComplete: boolean;
}): SettledWindow {
  if (!input.attempts.some((a) => a.sandboxIds.length > 0)) return noSandbox;
  const reasons = deletionProblems(input.attempts);

  const ours = new Set(input.attempts.flatMap((a) => a.sandboxIds));
  const own = input.events.filter((e) => ours.has(e.sandboxId));
  const kills = own.filter((e) => e.type === "sandbox.lifecycle.killed");
  const used = input.attempts.filter((a) => a.sandboxIds.length > 0);
  const first = Math.min(...used.map((a) => a.startedAt), ...own.map((e) => e.timestamp));
  const last = Math.max(...used.map((a) => a.endedAt), ...own.map((e) => e.timestamp));
  const start = Math.floor(first / HOUR_MS) * HOUR_MS;
  const end = (Math.floor(last / HOUR_MS) + 1) * HOUR_MS;
  const before = start - HOUR_MS;
  const after = end + HOUR_MS;

  if (!input.eventsComplete) reasons.push("the team's event list was not read to its end");

  for (const id of ours)
    if (!kills.some((e) => e.sandboxId === id)) reasons.push(`sandbox ${id} has no killed event`);

  const foreign = input.events.filter(
    (e) => !ours.has(e.sandboxId) && e.timestamp >= before && e.timestamp < after,
  );

  for (const id of new Set(foreign.map((e) => e.sandboxId)))
    reasons.push(`sandbox ${id}, not the run's, has events from ${iso(before)} to ${iso(after)}`);

  const outside = input.hours.filter(
    (h) => (h.start >= before && h.start < start) || (h.start >= end && h.start < after),
  );

  for (const h of outside)
    reasons.push(`the console shows usage in ${iso(h.start)}, outside the run`);

  const inPeriod = (hours: readonly E2bHour[]) =>
    hours.filter((h) => h.start >= start && h.start < end).sort((a, b) => a.start - b.start);

  const now = inPeriod(input.hours);
  const later = inPeriod(input.hoursRecheck);

  if (input.recheckGapMs < 30 * 60_000)
    reasons.push("the console's usage was not read again at least 30 minutes later");

  if (JSON.stringify(now) !== JSON.stringify(later))
    reasons.push("the console's hourly usage for the period changed between the two readings");

  // A segment is booked in the hour it ended, and only the run's sandboxes have events, so each
  // hour's sandbox count is the run's sandboxes that ended a segment then.
  for (const h of now) {
    const ended = new Set(
      own
        .filter(
          (e) =>
            (e.type === "sandbox.lifecycle.killed" || e.type === "sandbox.lifecycle.paused") &&
            e.timestamp >= h.start &&
            e.timestamp < h.start + HOUR_MS,
        )
        .map((e) => e.sandboxId),
    );

    if (ended.size !== h.sandboxCount)
      reasons.push(
        `the console counts ${h.sandboxCount} sandboxes in ${iso(h.start)}; the run ended segments of ${ended.size}`,
      );
  }

  return verdict(reasons, () => ({
    period: { start: iso(start), end: iso(end) },
    settledUSD: now.reduce((sum, h) => sum + h.usd, 0),
    isolation: `E2B's team-wide lifecycle events from ${iso(before)} to ${iso(after)} name only the run's ${ours.size} sandboxes; the console's hourly usage has nothing in ${iso(before)} or ${iso(end)}, and its sandbox count for each hour of the period is the run's sandboxes that ended a segment then`,
  }));
}
