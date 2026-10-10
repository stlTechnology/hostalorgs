#!/usr/bin/env node
/*
 * port_probe.js -- is a Quake port reachable from here?
 *
 *   node scripts/port_probe.js tcp <host> <port> [timeoutMs]
 *   node scripts/port_probe.js udp <host> <port> [timeoutMs]
 *
 * Exit 0 = reachable, 1 = not reachable (refused / filtered / no answer),
 * 2 = bad usage. One line of output either way, so a caller can paste it.
 *
 * Why this exists rather than a bash /dev/tcp test: two of the old checks in
 * scripts/install_service.sh could not fail, so they claimed to have proved
 * something they never tested.
 *
 *   - "/dev/tcp/[$IPV6]/$PORT" is not resolvable: bash splits the path on
 *     slashes and hands "[::1]" to getaddrinfo, so every IPv6 probe failed
 *     for the wrong reason and printed "ok, the game port refuses".
 *     Verified: `bash -c 'exec 3<>/dev/tcp/[::1]/9'` -> "Name or service not
 *     known", while the same probe without brackets -> "Connection refused".
 *   - the UDP half of the self-check ran /dev/tcp, i.e. TCP, twice. It printed
 *     "refuses over udp" without a single UDP packet ever being sent.
 *
 * The UDP probe sends a real connectionless QuakeWorld query,
 * ff ff ff ff "status", which a Quake server answers with its player list.
 * No answer within the timeout means the datagram was dropped or the port is
 * closed, which is what a firewalled game port looks like from the outside.
 * Note that "no answer" cannot distinguish DROP from an ICMP port-unreachable
 * on every kernel; both are "not reachable" here, which is the claim the
 * installer makes.
 */
'use strict';

const net = require('net');
const dgram = require('dgram');

/* The connectionless QuakeWorld header, then the command. server/proxy.js
 * uses the same four bytes, so the mock server answers this too. */
const QW_HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);

function usage(msg) {
  process.stderr.write(msg + '\n');
  process.stderr.write('usage: port_probe.js {tcp|udp} <host> <port> [timeoutMs]\n');
  process.exit(2);
}

const [proto, hostArg, portArg, timeoutArg] = process.argv.slice(2);
if (!proto || !hostArg || !portArg) usage('FATAL: not enough arguments');
/* Accept "[::1]" as well as "::1": bash's /dev/tcp cannot take the bracketed
 * form, and the same string is what people paste. */
const host = hostArg.replace(/^\[(.*)\]$/, '$1');
if (proto !== 'tcp' && proto !== 'udp') usage(`FATAL: unknown protocol '${proto}'`);
const port = Number(portArg);
if (!Number.isInteger(port) || port < 1 || port > 65535) usage(`FATAL: '${portArg}' is not a port`);
const timeoutMs = Number(timeoutArg || 2500);
const label = `${proto}/${host}:${port}`;

function tcpProbe() {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (reachable, why) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ reachable, why });
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true, 'connected'));
    sock.on('timeout', () => finish(false, 'timed out'));
    sock.on('error', (e) => finish(false, e.code || e.message));
  });
}

function udpProbe() {
  return new Promise((resolve) => {
    /* udp6 for an IPv6 literal host, udp4 otherwise; "::ffff:x.x.x.x" is an
     * IPv4 address wearing IPv6 syntax, so treat it as IPv4. */
    const isV6 = host.includes(':') && !host.startsWith('::ffff:');
    const sock = dgram.createSocket(isV6 ? 'udp6' : 'udp4');
    let done = false;
    const finish = (reachable, why) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch (_) { /* already closing */ }
      resolve({ reachable, why });
    };
    sock.on('error', (e) => finish(false, e.code || e.message));
    sock.on('message', (msg) => {
      const head = msg.slice(0, 4);
      finish(true, `answered ${msg.length} bytes` +
        (head.equals(QW_HEADER) ? ' (QW connectionless reply)' : ' (unexpected payload)'));
    });
    sock.send(Buffer.concat([QW_HEADER, Buffer.from('status', 'latin1')]), port, host,
      (err) => { if (err) finish(false, err.code || err.message); });
    setTimeout(() => finish(false, 'no answer'), timeoutMs);
  });
}

(async () => {
  const { reachable, why } = proto === 'tcp' ? await tcpProbe() : await udpProbe();
  process.stdout.write(`${label} ${reachable ? 'reachable' : 'not reachable'} (${why})\n`);
  process.exit(reachable ? 0 : 1);
})();