import { config } from './config';
import { createApp } from './app';

const { server, close } = await createApp();
server.listen(config.port, () => {
  console.log(`[syncbeat] listening on :${config.port} (${config.prod ? 'production' : 'development'}, ${config.databaseUrl ? 'postgres' : 'in-memory store'})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => void close().finally(() => process.exit(0)));
}
