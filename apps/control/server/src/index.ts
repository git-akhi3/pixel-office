import { randomUUID } from 'node:crypto';
import { loadAgents } from './agents.js';
import { ensureDirs, loadConfig, loadOauthToken } from './config.js';
import { getSettings, openDb, setSetting } from './db/index.js';
import { PixelBridge, titleFrom } from './pixelBridge.js';
import { EventBus } from './events.js';
import { GhPublisher } from './github.js';
import { Graphs } from './graph.js';
import { Knowledge } from './knowledge.js';
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
// My edited agents and skills (~/.office) override the built-in defaults.
const agents = loadAgents([config.customAgentsDir, config.agentsDir], [config.customSkillsDir, config.skillsDir], (m) => console.warn(m));
const knowledge = new Knowledge(db, config.knowledgeDir);
const graphs = new Graphs(config.graphsDir, config.worktreesDir);
const runner = new SdkRunner(token, (snapshot) =>
  setSetting(db, 'rateLimit', {
    fiveHour: snapshot.fiveHour,
    sevenDay: snapshot.sevenDay,
    fiveHourResetsAt: snapshot.fiveHourResetsAt,
    sevenDayResetsAt: snapshot.sevenDayResetsAt,
    resetsAt: snapshot.resetsAt,
    at: Date.now(),
  }),
);
const docs = new TaskDocs(config.tasksDir);
const pipeline = new Pipeline({ db, bus, config, agents, runner, publisher: new GhPublisher(), docs, knowledge, graphs });
const app = await buildServer({ db, bus, config, pipeline, docs, knowledge, graphs, pixel: () => bridge });

// Show the office's agents in the Pixel Agents office (no-op while it isn't running).
let pixelSessionId = getSettings(db).pixelSessionId;
if (!pixelSessionId) {
  pixelSessionId = randomUUID();
  setSetting(db, 'pixelSessionId', pixelSessionId);
}
const bridge = new PixelBridge({
  workspaceFile: config.pixelWorkspaceFile,
  sessionId: pixelSessionId,
  onRotate: (id) => setSetting(db, 'pixelSessionId', id),
  taskTitle: titleFrom((id) => pipeline.getTask(id)),
});
bridge.start(bus);

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
