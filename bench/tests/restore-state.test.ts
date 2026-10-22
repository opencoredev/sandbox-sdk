import {expect, it} from "vitest";
import {RestoreCleanup} from "../src/restore-state.js";

it("blocks a snapshot and its source until all of its alive/quarantined restores resolve", () => {
 const cleanup = new RestoreCleanup();
 const first = cleanup.begin("daytona", "snapshot", "source");
 const second = cleanup.begin("daytona", "snapshot", "source");
 cleanup.identify(first, "first", "alive");
 cleanup.identify(second, "second", "quarantined");
 expect(cleanup.blocksSnapshot("daytona", "snapshot")).toBe(true);
 expect(cleanup.blocksSource("daytona", "source")).toBe(true);
 cleanup.mark("daytona", "first", "destroyed");
 expect(cleanup.blocksSnapshot("daytona", "snapshot")).toBe(true);
 expect(cleanup.blocksSource("daytona", "source")).toBe(true);
 cleanup.mark("daytona", "second", "alive");
 expect(second.state).toEqual({kind: "alive", id: "second"});
 expect(cleanup.blocksSnapshot("daytona", "snapshot")).toBe(true);
 cleanup.mark("daytona", "second", "destroyed");
 expect(cleanup.blocksSnapshot("daytona", "snapshot")).toBe(false);
 expect(cleanup.blocksSource("daytona", "source")).toBe(false);
});

it("scopes restore dependencies by provider and snapshot/source identity", () => {
 const cleanup = new RestoreCleanup();
 const attempt = cleanup.begin("superserve", "snapshot", "source");
 cleanup.identify(attempt, "restore", "alive");
 cleanup.mark("daytona", "restore", "destroyed");
 expect(attempt.state.kind).toBe("alive");
 expect(cleanup.blocksSnapshot("daytona", "snapshot")).toBe(false);
 expect(cleanup.blocksSource("daytona", "source")).toBe(false);
 expect(cleanup.blocksSnapshot("superserve", "other-snapshot")).toBe(false);
 expect(cleanup.blocksSource("superserve", "other-source")).toBe(false);
 expect(cleanup.blocksSource("superserve", "source")).toBe(true);
});

it("holds unknown create outcomes and identified quarantined IDs until verified cleanup", () => {
 const cleanup = new RestoreCleanup();
 const pending = cleanup.begin("e2b", "snapshot", "source");
 expect(pending.state).toEqual({kind: "quarantined", id: null});
 expect(cleanup.blocksSnapshot("e2b", "snapshot")).toBe(true);
 cleanup.identify(pending, "restore", "quarantined");
 expect(pending.state).toEqual({kind: "quarantined", id: "restore"});
 cleanup.mark("e2b", "restore", "destroyed");
 expect(cleanup.blocksSnapshot("e2b", "snapshot")).toBe(false);
 cleanup.begin("e2b", "snapshot", "source");
 expect(cleanup.blocksSource("e2b", "source")).toBe(true);
});
