const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '.env');

function loadEnv() {
  const env = { ...process.env };
  if (fs.existsSync(ENV_PATH)) {
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!env[key]) env[key] = trimmed.slice(eq + 1).trim();
    }
  }
  for (const key of ['APP_ID', 'APP_SECRET', 'REDIRECT_URI', 'COOKIE_SECRET']) {
    if (!env[key]) throw new Error(`.env 에 ${key}가 없습니다.`);
  }
  return env;
}

module.exports = { loadEnv };
