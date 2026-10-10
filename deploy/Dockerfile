# M6 groundwork: the container publishes ONE port.
#
# Not a finished image -- containerising is M6 and the FTE binary plus the
# deployed snapshot are layered on there. What matters now is the property that
# makes the FTE bind gap harmless in production: only the gate's port is ever
# exposed, so FTE listening on 0.0.0.0 *inside* the container is unreachable
# from outside. Nothing can route to it, because nothing is published for it.
#
# The LAN deploy cannot rely on that, which is why install_service.sh drops
# non-loopback traffic to the game port with iptables instead.
#
# tests/test_gate.js checks that this file exposes the gate port and never the
# game port, so adding `EXPOSE 27500` here fails a test rather than quietly
# publishing the game server to the internet.

FROM node:22-slim

# The gate's port only. The platform ingress maps the public HTTPS port to this.
EXPOSE 8080

ENV GATE_HOST=0.0.0.0 \
    GATE_PORT=8080 \
    FTE_HOST=127.0.0.1 \
    FTE_PORT=27500 \
    GATE_ENV=production

# GATE_SECRET and GATE_ROOT are supplied at run time from the platform's
# secret store and the deployed snapshot. GATE_SECRET is not optional here:
# gate.js refuses to start in production without it.

WORKDIR /srv/qwtf
COPY server/gate.js ./server/gate.js

# One replica per match: the game server is stateful, so no autoscale-out across
# a running match (PROJECT.md, production notes).
CMD ["node", "server/gate.js"]