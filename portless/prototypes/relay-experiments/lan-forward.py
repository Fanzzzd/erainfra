#!/usr/bin/env python3
# Minimal TCP forwarder so a LAN box (Windows .46) can reach a hub that only listens on work-remote's
# loopback (the Mac hub, reverse-tunneled to 127.0.0.1:18787). Binds the LAN IP because the hub's
# reverse tunnel can't (sshd GatewayPorts=no). ponytail: raw byte pump, no TLS — fine for a transient
# enrollment over a trusted LAN. Run: python3 lan-forward.py [listen_port] [dst_port]
import asyncio, sys

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18080
DST_HOST, DST_PORT = "127.0.0.1", int(sys.argv[2]) if len(sys.argv) > 2 else 18787

async def pipe(r, w):
    try:
        while True:
            b = await r.read(65536)
            if not b:
                break
            w.write(b); await w.drain()
    except Exception:
        pass
    finally:
        try: w.close()
        except Exception: pass

async def handle(cr, cw):
    try:
        sr, sw = await asyncio.open_connection(DST_HOST, DST_PORT)
    except Exception:
        cw.close(); return
    await asyncio.gather(pipe(cr, sw), pipe(sr, cw))

async def main():
    s = await asyncio.start_server(handle, LISTEN_HOST, LISTEN_PORT)
    print(f"forwarding {LISTEN_HOST}:{LISTEN_PORT} -> {DST_HOST}:{DST_PORT}", flush=True)
    async with s:
        await s.serve_forever()

asyncio.run(main())
