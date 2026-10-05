// server.js — validates configuration, checks the database, then listens.
const { env, validateEnv } = require('./config/env');

async function main() {
  try {
    validateEnv();
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    process.exit(1);
  }
  const { ping } = require('./config/db');
  try {
    await ping();
  } catch (e) {
    console.error(`FATAL: cannot connect to MySQL ${env.db.user}@${env.db.host}:${env.db.port}/${env.db.database} — ${e.message}`);
    process.exit(1);
  }
  const { buildApp } = require('./app');
  buildApp().listen(env.port, () => {
    console.log(`Equipment Flow API listening on http://localhost:${env.port} (db ${env.db.database}, tz ${env.timeZone})`);
  });
}

main();
