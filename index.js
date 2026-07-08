const { tickRoundClock } = require('./src/lib/roundClock');
const http = require('http');

http.createServer((req, res) => res.end('ok')).listen(process.env.PORT || 3000);

setInterval(() => {
  tickRoundClock().catch(console.error);
}, 1000);