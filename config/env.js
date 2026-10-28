// config/env.js — reads and validates environment variables once (fail fast).
require('dotenv').config({ quiet: true });

function str(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function int(name, def) {
  const v = str(name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`Environment variable ${name} must be an integer`);
  return n;
}
function bool(name, def) {
  const v = str(name);
  if (v === undefined) return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const env = {
  nodeEnv: str('NODE_ENV', 'development'),
  port: int('PORT', 5055),
  db: {
    host: str('DB_HOST', '127.0.0.1'),
    port: int('DB_PORT', 3306),
    user: str('DB_USER', 'equipment_asik_user'),
    password: str('DB_PASSWORD', ''),
    database: str('DB_NAME', 'equipment_asik'),
    ssl: bool('DB_SSL', false),
  },
  jwtSecret: str('JWT_SECRET'),
  jwtExpiresIn: str('JWT_EXPIRES_IN', '12h'),
  corsOrigins: str('CORS_ORIGINS', '*').split(',').map((s) => s.trim()).filter(Boolean),
  timeZone: str('APP_TIME_ZONE', 'Asia/Damascus'), // Syria: UTC+3 all year
  storage: {
    driver: str('FILE_STORAGE_DRIVER', 'local'),
    dir: str('FILE_STORAGE_DIR', require('path').join(__dirname, '..', 'storage')),
    s3: {
      bucket: str('S3_BUCKET'), region: str('S3_REGION', 'auto'), endpoint: str('S3_ENDPOINT'),
      accessKeyId: str('S3_ACCESS_KEY_ID'), secretAccessKey: str('S3_SECRET_ACCESS_KEY'),
    },
  },
  loginRateLimitMax: int('LOGIN_RATE_LIMIT_MAX', 20),
  bcryptCost: int('BCRYPT_COST', 12),
  // Shared secret for server-to-server reads by Team Flow (combined Project Daily Report). Empty = integration off.
  integrationToken: str('INTEGRATION_TOKEN', ''),
  // Telegram bot for site supervisors (its own bot, not Team Flow's). Off unless TELEGRAM_BOT_ENABLED=true and the
  // token + webhook secret are set; when off, the bot routes answer 503 and nothing else changes.
  telegram: {
    enabled: bool('TELEGRAM_BOT_ENABLED', false),
    botToken: str('TELEGRAM_BOT_TOKEN', ''),
    botUsername: str('TELEGRAM_BOT_USERNAME', '').replace(/^@/, ''),
    webhookSecret: str('TELEGRAM_WEBHOOK_SECRET', ''),
    // the public address of this server (e.g. https://equipment-asik.onrender.com), used to register the webhook
    publicUrl: str('PUBLIC_BASE_URL', '').replace(/\/+$/, ''),
    // where the bot calls this server's own API (default http://127.0.0.1:PORT)
    loopbackUrl: str('TELEGRAM_LOOPBACK_URL', '').replace(/\/+$/, ''),
  },
};

function validateEnv() {
  const problems = [];
  if (!env.jwtSecret || env.jwtSecret.length < 32) problems.push('JWT_SECRET is missing or shorter than 32 characters');
  if (!env.db.database) problems.push('DB_NAME is required');
  if (!['local', 's3'].includes(env.storage.driver)) problems.push('FILE_STORAGE_DRIVER must be local or s3');
  if (env.integrationToken && env.integrationToken.length < 32) problems.push('INTEGRATION_TOKEN must be at least 32 characters (or empty to switch the integration off)');
  if (env.storage.driver === 's3' && !env.storage.s3.bucket) problems.push('S3_BUCKET is required with FILE_STORAGE_DRIVER=s3');
  if (problems.length) {
    const err = new Error(`Invalid configuration:\n - ${problems.join('\n - ')}`);
    err.problems = problems;
    throw err;
  }
}

module.exports = { env, validateEnv };
