import { setTimeout as delay } from 'node:timers/promises';
for (const url of ['http://127.0.0.1:3001/v1/health', 'http://localhost:3000/login']) {
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(1000);
  }
  if (!ready) throw new Error(`Startup failed: ${url}; inspect .local/application.log`);
}
console.log('Web and API are responding.');
