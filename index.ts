process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

console.log('Starting provadice-astrid-agent...');

import { tickClock, initRoundClock } from './roundClock.js';
import http from 'http';

const port = process.env.PORT || 3000;
http.createServer((req, res) => res.end('ok')).listen(port, () => {
  console.log(`Health check server listening on port ${port}`);
});

initRoundClock().then(() => {
  console.log('Round clock initialized.');
  setInterval(() => {
    tickClock().catch((err: unknown) => console.error('tickClock error:', err));
  }, 1000);
}).catch((err) => console.error('initRoundClock failed:', err));

console.log('Startup complete, entering tick loop.');
