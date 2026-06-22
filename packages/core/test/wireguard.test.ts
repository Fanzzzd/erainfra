import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWireGuardConfig, renderWireGuardIni } from '../src/wireguard.ts';
import { sampleMachines, samplePaths } from '../src/sample.ts';

const keyring = [
  { machineId: 'machine-a', privateKey: 'priv-a', publicKey: 'pub-a' },
  { machineId: 'machine-b', privateKey: 'priv-b', publicKey: 'pub-b' },
  { machineId: 'machine-c', privateKey: 'priv-c', publicKey: 'pub-c' },
];

test('renders peer routes to node ip and container subnet', () => {
  const config = buildWireGuardConfig({
    self: sampleMachines[0],
    machines: sampleMachines,
    keyring,
    paths: samplePaths,
  });
  const ini = renderWireGuardIni(config);

  assert.match(ini, /Address = 10\.88\.0\.10\/32/);
  assert.match(ini, /AllowedIPs = 10\.88\.0\.11\/32, 10\.210\.1\.0\/24/);
  assert.match(ini, /Endpoint = 192\.168\.10\.11:51820/);
  assert.match(ini, /AllowedIPs = 10\.88\.0\.12\/32, 10\.210\.2\.0\/24/);
  assert.match(ini, /PersistentKeepalive = 25/);
});
