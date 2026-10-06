import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { loadAgents } from './agents.js';
import { ensureDirs, loadConfig, loadEnvFile, loadOauthToken, remoteConfig, slackConfig } from './config.js';
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
import { Uploads } from './attachments.js';
import { startSlack } from './slack.js';

const config = loadConfig();
ensureDirs(config);

let token: string;
try {
  token = loadOauthToken(config.envFile);
} catch (e) {
  console.error(`\n${(e as Error).message}\n`);
  process.exit(1);
}

// One office per data folder. Check before touching the database: a second copy must not run
// startup recovery (which parks running steps) underneath the one that is serving.
if (await portInUse(config.host, config.port)) {
  console.error(`\nThe office is already running on http://${config.host}:${config.port}. Stop that one first (Ctrl-C in its terminal).\n`);
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
const uploads = new Uploads(config.uploadsDir);
const pipeline = new Pipeline({ db, bus, config, agents, runner, publisher: new GhPublisher(), docs, knowledge, graphs, uploads });
const app = await buildServer({ db, bus, config, pipeline, docs, knowledge, graphs, uploads, pixel: () => bridge });

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
// Claim the port before recovery and scheduling, so a lost race also exits before changing anything.
await app.listen({ host: config.host, port: config.port });
bridge.start(bus);
pipeline.start();
console.log(`Pixel Office control: http://${config.host}:${config.port}  (data: ${config.home})`);

// Slack is optional. A mistake in its settings or a failed connection must not take the office down.
let slack: Awaited<ReturnType<typeof startSlack>> | null = null;
try {
  const env = loadEnvFile(config.envFile);
  const slackSettings = slackConfig(env);
  if (slackSettings) {
    slack = await startSlack(slackSettings, { db, bus, pipeline, docs, uploads, publicUrl: remoteConfig(config, env).publicUrl });
    await slack.bridge.announce();
    console.log('Slack: connected. DM the bot to start a task.');
  }
} catch (e) {
  console.error(`Slack is off: ${(e as Error).message}`);
}

const shutdown = async () => {
  console.log('Shutting down: running steps are stopped; resume them from the board.');
  await slack?.stop().catch(() => undefined);
  await pipeline.shutdown();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function portInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}
