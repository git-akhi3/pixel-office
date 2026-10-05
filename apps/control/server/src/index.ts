import { loadAgents } from './agents.js';
import { ensureDirs, loadConfig, loadOauthToken } from './config.js';
import { openDb, setSetting } from './db/index.js';
import { EventBus } from './events.js';
import { GhPublisher } from './github.js';
import { TaskDocs } from './handoffs.js';
import { Pipeline } from './pipeline.js';
import { SdkRunner } from './runner.js';
import { buildServer } from './server.js';

const config = loadConfig();
ensureDirs(config);

let token: string;
try {
  token = loadOauthToken(config.envFile);
} catch (e) {
  console.error(`\n${(e as Error).message}\n`);
  process.exit(1);
}

const db = openDb(config.dbPath);
const bus = new EventBus(db);
const agents = loadAgents(config.agentsDir, config.skillsDir);
const runner = new SdkRunner(token, (snapshot) =>
  setSetting(db, 'rateLimit', { fiveHour: snapshot.fiveHour, sevenDay: snapshot.sevenDay, resetsAt: snapshot.resetsAt, at: Date.now() }),
);
const docs = new TaskDocs(config.tasksDir);
const pipeline = new Pipeline({ db, bus, config, agents, runner, publisher: new GhPublisher(), docs });
const app = await buildServer({ db, bus, config, pipeline, docs });

pipeline.start();
await app.listen({ host: config.host, port: config.port });
console.log(`Pixel Office control: http://${config.host}:${config.port}  (data: ${config.home})`);

const shutdown = async () => {
  console.log('Shutting down: running steps are stopped; resume them from the board.');
  await pipeline.shutdown();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
