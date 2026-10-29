import { afterEach, expect, it, vi } from "vitest";
import { boxdState, MockBoxd } from "../../packages/sdk/tests/cloud-guest-mock.js";
import { cleanupMock, mockState, MockDaytona } from "../../packages/sdk/tests/daytona-mock.js";

vi.mock("../../packages/sdk/node_modules/@boxd-sh/sdk", () => ({ Boxd: MockBoxd }));

vi.mock("../../packages/sdk/node_modules/@daytonaio/sdk", () => ({ Daytona: MockDaytona }));

import { boxd } from "../../packages/sdk/src/providers/boxd/index.js";
import { daytona } from "../../packages/sdk/src/providers/daytona/index.js";

afterEach(async () => {
  await Promise.all([...boxdState.boxes.values()].map((v) => v.guest.destroy()));
  boxdState.boxes.clear();
  await cleanupMock();
  vi.restoreAllMocks();
});

it("boxd inherits its coupled 100 GB disk when omitted and rejects a conflicting disk", async () => {
  const provider = boxd({ apiKey: "offline" });
  const box = await provider.create({ labels: {}, size: { cpu: 4, memoryMb: 16384 } });
  expect(boxdState.creates.at(-1)?.config?.vcpu).toBe(4);
  await expect(
    provider.create({ labels: {}, size: { cpu: 4, memoryMb: 16384, diskGb: 5 } }),
  ).rejects.toMatchObject({ code: "unsupported" });
  await provider.destroy(box.id);
});

it("Daytona supplies its own 10 GB default disk", async () => {
  const provider = daytona({ apiKey: "offline", image: "node" });
  const box = await provider.create({ labels: {}, size: { cpu: 4, memoryMb: 8192 } });
  expect(mockState.creates.at(-1)).toMatchObject({ resources: { cpu: 4, memory: 8, disk: 10 } });
  await provider.destroy(box.id);
});
