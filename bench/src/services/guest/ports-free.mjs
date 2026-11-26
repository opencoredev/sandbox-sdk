// Exit 0 only when nothing answers on any of these 127.0.0.1 ports, so a server the image already
// runs can never stand in for the one the attempt starts. Usage: node ports-free.mjs PORT...
import { connect } from "node:net";

const answers = (port) =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 2000 });

    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });

const ports = process.argv.slice(2).map(Number);
const busy = [];

for (const port of ports) if (await answers(port)) busy.push(port);

process.stdout.write(`${JSON.stringify({ busy })}\n`);

process.exitCode = busy.length ? 1 : 0;
