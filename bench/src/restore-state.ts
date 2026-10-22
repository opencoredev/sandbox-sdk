/** Every restore remains a cleanup dependency until deletion or exact absence is established. */
export type RestoreState =
  | {kind: "alive"; id: string}
  | {kind: "quarantined"; id: string | null}
  | {kind: "destroyed"; id: string};
export interface RestoreAttempt {
  provider: string;
  snapshotId: string;
  sourceId: string;
  state: RestoreState;
}
export class RestoreCleanup {
  private readonly attempts: RestoreAttempt[] = [];
  begin(provider: string, snapshotId: string, sourceId: string): RestoreAttempt {
    const attempt: RestoreAttempt = {provider, snapshotId, sourceId, state: {kind: "quarantined", id: null}};
    this.attempts.push(attempt);
    return attempt;
  }
  identify(attempt: RestoreAttempt, id: string, kind: "alive" | "quarantined") {
    attempt.state = {kind, id};
  }
  mark(provider: string, id: string, kind: RestoreState["kind"]) {
    for (const attempt of this.attempts)
      if (attempt.provider === provider && attempt.state.id === id) attempt.state = {kind, id};
  }
  blocksSnapshot(provider: string, snapshotId: string) {
    return this.attempts.some(a => a.provider === provider && a.snapshotId === snapshotId && a.state.kind !== "destroyed");
  }
  blocksSource(provider: string, sourceId: string) {
    return this.attempts.some(a => a.provider === provider && a.sourceId === sourceId && a.state.kind !== "destroyed");
  }
}
