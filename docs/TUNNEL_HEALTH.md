# Reverse SSH tunnel transfer checks

An SSH process and its forwarded TCP listener can remain alive while packet
retransmissions make uploads unusably slow. A successful request for the small
HTML entry page does not establish that the tunnel transfers data normally.

`scripts/tunnel-transfer-probe.py` checks both directions of a loopback HTTP
forward without credentials, uploaded files, or model turns. It discovers the
current JavaScript asset from `/`, requests a 128 KiB byte range, and sends
16 concurrent read-only requests with 8 KiB headers. The remaining responses
come from `/api/auth/status`. It requires Python 3 and no third-party modules.

Run it on the relay, pointing at the SSH-forwarded loopback port:

```bash
timeout 8 python3 scripts/tunnel-transfer-probe.py --port 12100 --timeout 6
```

Success prints elapsed seconds and byte counts and exits with status 0.
Failure exits nonzero. Keep the outer `timeout`: the HTTP socket timeout alone
does not bound a response that continues to trickle bytes. The probe bypasses
ambient HTTP proxy settings and does not log response bodies or headers.

When integrating into an existing watchdog:

1. Check the application directly on its host first. If that fails, clear the
   tunnel failure streak and leave tunnel recovery to a later healthy check.
2. Check the relay listener, then run this probe over a separate management SSH
   connection. Bound the entire management command as well.
3. Require two consecutive failed checks before restarting only the affected
   tunnel. Keep a restart cooldown and a lock against overlapping checks.
4. Record the reason and preserve the application process. Do not restart
   unrelated tunnels, the reverse proxy, or an active model turn.

A one-minute interval transfers approximately 256 KiB per check, excluding
protocol overhead. A six-second deadline catches severe transfer degradation;
it is not a guarantee of normal browser latency or a measurement of the cause
of packet loss. Test the deadline against the deployment's healthy baseline.

Validate the probe with:

```bash
python3 -B tests/ops/test_tunnel_transfer_probe.py
```

The tests cover successful transfer, a fast entry page with slow data transfer,
and a truncated ranged response. Separately verify the watchdog's consecutive
failure, local-application failure, cooldown, and recovery branches using
stubbed restart commands before changing a live watchdog.
