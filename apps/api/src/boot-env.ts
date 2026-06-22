// Side-effect module: set durable-state file defaults BEFORE the router builds its singletons.
// Imported first by the server entrypoint so `node server.ts` persists projects + fabric with no
// config. Tests import router.ts directly (never this), so they stay in-memory and hermetic.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = join(tmpdir(), 'portless-runtime');
process.env.PORTLESS_PROJECTS_FILE ??= join(dir, 'projects.json');
process.env.PORTLESS_FABRIC_FILE ??= join(dir, 'fabric.json');
