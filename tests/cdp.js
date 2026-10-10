// Minimal RFC6455 client, just enough for Chrome DevTools Protocol.
//
// CDP speaks WebSocket, and the repo has no node_modules (and no network
// install step), so this implements the handshake and the text frames we need:
// client->server frames are always masked, server->client never are, and the
// payloads here are small JSON messages.
'use strict';
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

function connect(url, onMessage) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(parseInt(u.port, 10), u.hostname, () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n');
    });
    sock.on('error', reject);
    /* Emit close so a caller can fail its pending calls immediately instead of
     * leaving every one of them to hang until its own timeout (seen as a 60 s
     * Page.navigate timeout with no other symptom). Additive: existing callers
     * that do not listen are unaffected. */
    sock.on('close', () => { try { api.emit('close'); } catch (e) {} });

    let buf = Buffer.alloc(0);
    let handshaken = false;

    const api = new EventEmitter();
    api.send = (text) => {
      const payload = Buffer.from(text, 'utf8');
      const len = payload.length;
      let header;
      if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = 0x80 | len;
      } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }
      header[0] = 0x81; // FIN + text
      const mask = crypto.randomBytes(4);
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
      sock.write(Buffer.concat([header, mask, masked]));
    };
    api.close = () => { try { sock.destroy(); } catch (e) {} };

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaken) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.slice(0, end).toString();
        if (!/101/.test(head.split('\r\n')[0])) {
          return reject(new Error('websocket upgrade failed: ' + head.split('\r\n')[0]));
        }
        buf = buf.slice(end + 4);
        handshaken = true;
        resolve(api);
      }
      /* decode as many complete frames as we have */
      for (;;) {
        if (buf.length < 2) return;
        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < off + 2) return;
          len = buf.readUInt16BE(off); off += 2;
        } else if (len === 127) {
          if (buf.length < off + 8) return;
          len = Number(buf.readBigUInt64BE(off)); off += 8;
        }
        let maskKey = null;
        if (masked) {
          if (buf.length < off + 4) return;
          maskKey = buf.slice(off, off + 4); off += 4;
        }
        if (buf.length < off + len) return;
        let payload = Buffer.from(buf.slice(off, off + len));
        buf = buf.slice(off + len);
        if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
        if (opcode === 0x8) { api.close(); try { api.emit('close'); } catch (e) {} return; }      // close
        if (opcode === 0x9) { continue; }                 // ping: ignore
        if (opcode === 0xa) { continue; }                 // pong: ignore
        if (opcode === 0x1 && fin) {
          try { onMessage(JSON.parse(payload.toString('utf8'))); } catch (e) {}
        }
      }
    });
  });
}

module.exports = { connect };