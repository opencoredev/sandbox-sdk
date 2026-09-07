import { defineCapabilities } from "../core/capabilities";

export const localCapabilities = defineCapabilities({
  "files.read": "full",
  "files.write": "full",
  "files.list": "full",
  "files.remove": "full",
  "process.run": "combined-stream",
  "process.stream": "combined-stream",
  "process.background": "full",
  "process.stdin": "full",
  "process.cancel": "full",
  "ports.expose": "in-process",
  "snapshot.create": "filesystem",
  "snapshot.delete": "filesystem",
  "snapshot.restore": "filesystem",
  "sandbox.resume": "memory",
  "filesystem.persistent": "ephemeral",
  "network.policy": "native",
});

/** @deprecated AgentOS capabilities are exposed as Local capabilities. */
export const agentosCapabilities = localCapabilities;

export const e2bCapabilities = defineCapabilities({
  "files.read": "full",
  "files.write": "full",
  "files.list": "full",
  "files.remove": "full",
  "process.run": "separate-streams",
  "process.stream": "separate-streams",
  "process.background": "full",
  "process.stdin": "full",
  "process.cancel": "full",
  "process.pty": "native",
  "ports.expose": "authenticated",
  "ports.authenticatedRequest": "authenticated",
  "snapshot.create": "template",
  "snapshot.delete": "template",
  "sandbox.resume": "memory",
  "sandbox.connect": "native",
  "sandbox.list": "native",
  "sandbox.timeout": "native",
  "filesystem.persistent": "ephemeral",
  "image.custom": "template",
  "network.policy": "native",
});

export const daytonaCapabilities = defineCapabilities({
  "files.read": "full",
  "files.write": "full",
  "files.list": "full",
  "files.remove": "full",
  "process.run": "combined-stream",
  "process.stream": "separate-streams",
  "process.background": "full",
  "process.stdin": "full",
  "process.cancel": "full",
  "process.pty": "native",
  "ports.expose": "authenticated",
  "ports.authenticatedRequest": "authenticated",
  "sandbox.connect": "native",
  "sandbox.list": "native",
  "filesystem.persistent": "persistent",
  "image.custom": "native",
  "network.policy": "native",
  "compute.gpu": "native",
});

export const vercelCapabilities = defineCapabilities({
  "files.read": "full",
  "files.write": "full",
  "files.list": "full",
  "files.remove": "full",
  "process.run": "separate-streams",
  "process.stream": "separate-streams",
  "process.background": "full",
  "process.cancel": "full",
  "process.pty": "native",
  "ports.expose": "public",
  "snapshot.create": "filesystem",
  "snapshot.delete": "filesystem",
  "sandbox.resume": "persistent",
  "sandbox.connect": "native",
  "sandbox.list": "native",
  "sandbox.timeout": "native",
  "filesystem.persistent": "persistent",
  "network.policy": "native",
});

export const upstashCapabilities = defineCapabilities({
  "files.read": "full",
  "files.write": "full",
  "files.list": "full",
  "files.remove": "full",
  "process.run": "combined-stream",
  "process.stream": "combined-stream",
  "process.background": "full",
  "ports.expose": "authenticated",
  "ports.authenticatedRequest": "authenticated",
  "snapshot.create": "filesystem",
  "snapshot.delete": "filesystem",
  "sandbox.resume": "persistent",
  "filesystem.persistent": "persistent",
  "image.custom": "native",
  "network.policy": "native",
});

export const boxCapabilities = defineCapabilities({
  "files.read": "full",
  "files.write": "full",
  "files.list": "full",
  "files.remove": "full",
  "process.run": "separate-streams",
  "ports.expose": "public",
  "ports.authenticatedRequest": "authenticated",
  "sandbox.resume": "persistent",
  "filesystem.persistent": "persistent",
});

export const memoryCapabilities = defineCapabilities({
  "files.read": "memory",
  "files.write": "memory",
  "files.list": "memory",
  "files.remove": "memory",
  "process.run": "in-process",
  "filesystem.persistent": "ephemeral",
});

export const cloudflareCapabilities = defineCapabilities({
  "files.read": "full",
  "files.write": "full",
  "files.list": "full",
  "files.remove": "full",
  "process.run": "combined-stream",
  "ports.expose": "public",
  "sandbox.connect": "native",
  "sandbox.resume": "persistent",
  "filesystem.persistent": "persistent",
});

export const railwayCapabilities = defineCapabilities({
  "files.read": "full",
  "files.write": "full",
  "files.list": "full",
  "files.remove": "full",
  "process.run": "separate-streams",
  "process.stream": "separate-streams",
  "process.background": "full",
  "process.cancel": "full",
  "snapshot.create": "filesystem",
  "snapshot.delete": "filesystem",
  "filesystem.persistent": "persistent",
  "image.custom": "template",
  "network.policy": "native",
});
