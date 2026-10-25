import { config } from './config';
import { createApp } from './app';
import { redact } from './redact';

// Listen first: during a zero-downtime update this server answers health checks as a standby while the
// old one hands over the database (docs/DOKPLOY.md).
const { app, ready, shutdown } = await createApp();
await app.listen({ port: config.API_PORT, host: config.HOST });
console.log(`Ripburn server (build ${config.BUILD_ID}) listening on http://${config.HOST}:${config.API_PORT}`);
ready.then(
  s => console.log(`Ripburn is active (${s.practice ? 'practice' : config.live ? 'mainnet' : 'read-only'}).`),
  // Startup failed (bad config, no database): the health check now says so, and Swarm keeps the old version.
  error => console.error(`Ripburn could not start: ${redact((error as Error).message)}`),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void shutdown().finally(() => process.exit(0)); });
