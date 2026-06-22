# Netmaker integration note

Portless should treat Netmaker as a hidden network backend:

1. Create one Netmaker network per Portless tenant or environment.
2. Install `netclient` through the Portless node-agent.
3. Use Netmaker for WireGuard keys, NAT traversal, peer updates, and relay fallback.
4. Store only derived state in Portless: node overlay IP, path quality, last handshake, relay/direct mode.
5. Keep service-to-service traffic on kernel WireGuard, not Cloudflare Mesh.

In production, expose the Netmaker UI/API through Cloudflare Tunnel if the Netmaker server itself has no public IP. For maximum data-plane performance, deploy regional relay nodes where direct WireGuard cannot be established.
