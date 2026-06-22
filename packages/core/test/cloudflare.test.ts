import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCloudflaredConfig } from '../src/cloudflare.ts';

test('renders cloudflared ingress config', () => {
  const yaml = renderCloudflaredConfig({
    tunnelId: '11111111-1111-1111-1111-111111111111',
    credentialsFile: '/etc/cloudflared/tunnel.json',
    routes: [{ hostname: 'api.example.com', serviceUrl: 'http://traefik.service.consul:80' }],
  });

  assert.match(yaml, /tunnel: 11111111-1111-1111-1111-111111111111/);
  assert.match(yaml, /hostname: api\.example\.com/);
  assert.match(yaml, /service: http:\/\/traefik\.service\.consul:80/);
  assert.match(yaml, /http_status:404/);
});
