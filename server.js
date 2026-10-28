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
    registerTelegramWebhook();
  });
}

/** Telegram bot switched on: (re)registers its webhook on every start, so setting the variables + a redeploy is enough. */
async function registerTelegramWebhook() {
  const tg = require('./services/telegram/telegramApi');
  if (!tg.enabled() || !/^https:\/\//.test(env.telegram.publicUrl)) return;
  try {
    await tg.callApi('setWebhook', {
      url: `${env.telegram.publicUrl}/api/telegram/webhook`, secret_token: env.telegram.webhookSecret,
      allowed_updates: ['message', 'edited_message', 'callback_query'],
    });
    console.log('Telegram bot: webhook registered.');
  } catch (e) {
    console.error(`Telegram bot: could not register the webhook — ${e.message}`);
  }
}

main();
