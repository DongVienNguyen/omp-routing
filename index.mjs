import { fileURLToPath } from 'node:url';
import { registerSettings, loadBindings, assertRuntime, preflight } from './settings.mjs';
import registerRouting from './runtime/supervised-lifecycle.mjs';

export default function portableRouting(pi) {
  const {canEdit, assertSource} = registerRouting(pi, fileURLToPath(import.meta.url), { loadBindings, assertRuntime, preflight });
  registerSettings(pi, canEdit, assertSource);
}
