// Mimic the browser's ws-client.ts behavior exactly: auth, ping every 10s,
// detect server pong replies. Run for 35s to span the relay's 30s ping
// interval and see if anything strange happens.
const WS = require('ws');
const fs = require('fs');
const port = parseInt(process.env.PORT || '14100', 10);
const { token } = JSON.parse(
  fs.readFileSync(process.env.HOME + '/.ccremote/config.json', 'utf8'),
);
const ws = new WS('ws://127.0.0.1:' + port + '/_relay');

let connected = false;
let pingTimer;
let lastPongAt = 0;

function log(...args) {
  console.log(`[${(Date.now() % 1e6).toString().padStart(6, '0')}]`, ...args);
}

ws.on('open', () => {
  log('open, sending auth');
  ws.send(JSON.stringify({ type: 'auth', token }));
});
ws.on('ping', () => log('<- WS ping (server)'));
ws.on('pong', () => log('<- WS pong (server)'));
ws.on('message', (d) => {
  const msg = JSON.parse(d.toString());
  if (msg.type === 'pong') {
    lastPongAt = Date.now();
    log('<- pong');
    return;
  }
  log('<- msg', msg.type, msg.reason || '');
  if (msg.type === 'auth:success') {
    connected = true;
    lastPongAt = Date.now();
    pingTimer = setInterval(() => {
      const since = Date.now() - lastPongAt;
      if (since > 25000) {
        log('!! 25s since last pong, would close');
        ws.close();
        return;
      }
      log('-> ping (since pong:', since, 'ms)');
      ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
    }, 10000);
  }
});
ws.on('close', (code, reason) => {
  log('CLOSE', code, reason.toString() || '(empty)');
  if (pingTimer) clearInterval(pingTimer);
  process.exit(0);
});
ws.on('error', (err) => log('err', err.message));
setTimeout(() => {
  log('test duration done, closing');
  ws.close();
}, 35000);
