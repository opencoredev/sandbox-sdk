import { connect, migrate, start } from "./app.js";
import { config } from "./config.js";

const settings = config();
const services = await connect(settings);
await migrate(services.pool);
const server = await start({ services, port: settings.port || 3000 });
const address = server.address();
process.stdout.write(`listening on ${typeof address === "object" ? address?.port : address}\n`);
