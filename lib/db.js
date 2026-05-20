import pg from 'pg';

const { Pool } = pg;

let pool;

function getConnectionString() {
  return process.env.DATABASE_URL || '';
}

function stripSslMode(connectionString) {
  return connectionString.replace(/([?&])sslmode=[^&]+&?/i, (_match, prefix) => {
    return prefix === '?' ? '?' : '';
  }).replace(/\?$/, '');
}

function buildPoolConfig() {
  const connectionString = getConnectionString();
  if (connectionString) {
    const sanitizedConnectionString = stripSslMode(connectionString);
    const useSsl = !/localhost|127\.0\.0\.1/.test(sanitizedConnectionString);
    return {
      connectionString: sanitizedConnectionString,
      ssl: useSsl ? { rejectUnauthorized: false } : false
    };
  }

  const {
    PGHOST,
    PGPORT,
    PGDATABASE,
    PGUSER,
    PGPASSWORD
  } = process.env;

  if (!PGHOST || !PGDATABASE || !PGUSER) return null;

  return {
    host: PGHOST,
    port: PGPORT ? Number(PGPORT) : 5432,
    database: PGDATABASE,
    user: PGUSER,
    password: PGPASSWORD,
    ssl: { rejectUnauthorized: false }
  };
}

export function hasDatabaseConfig() {
  return Boolean(buildPoolConfig());
}

export function getPool() {
  if (pool) return pool;
  const config = buildPoolConfig();
  if (!config) throw new Error('Database is not configured');
  pool = new Pool({ ...config, max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000 });
  return pool;
}

export async function query(text, params = []) {
  return getPool().query(text, params);
}
