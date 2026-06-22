import test from 'node:test';
import assert from 'node:assert/strict';
import { renderNomadJob } from '../src/nomad.ts';
import { sampleApp } from '../src/sample.ts';

test('renders Nomad job with rolling update and health check', () => {
  const service = sampleApp.services.find((item) => item.name === 'api')!;
  const hcl = renderNomadJob({ project: sampleApp.project, environment: sampleApp.environment, service });

  assert.match(hcl, /job "demo-shop-prod-api"/);
  assert.match(hcl, /auto_revert\s+= true/);
  assert.match(hcl, /type\s+= "http"/);
  assert.match(hcl, /path\s+= "\/health"/);
  assert.match(hcl, /image = "ghcr\.io\/example\/demo-api:sha-abc123"/);
});
