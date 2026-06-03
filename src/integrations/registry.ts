import { logger } from '../logger.js';

/**
 * An integration ("flow") is a background capability that runs alongside the
 * message loop — typically a polling loop that syncs an external system into
 * the KB, or a recurring job. This registry mirrors the channel registry
 * (src/channels/registry.ts): modules self-register at import time via a barrel
 * (src/integrations/index.js), and the orchestrator starts whatever is present.
 *
 * To add an org- or app-specific flow, create a module that calls
 * registerIntegration({...}) and import it from a barrel (the core barrel, or a
 * profile-supplied one). See docs/PLUGINS.md.
 */
export interface Integration {
  /** Stable identifier, also used in logs. */
  name: string;
  /** Start the flow. Should be idempotent and no-op if its config is absent. */
  start: () => void;
  /** Optional clean shutdown (clear timers, close handles). */
  stop?: () => void;
}

const registry = new Map<string, Integration>();

export function registerIntegration(integration: Integration): void {
  if (registry.has(integration.name)) {
    logger.warn(
      { integration: integration.name },
      'Integration name already registered — overwriting the previous one',
    );
  }
  registry.set(integration.name, integration);
}

export function getRegisteredIntegrations(): Integration[] {
  return [...registry.values()];
}

/** Start every registered integration. Failures are isolated, not fatal. */
export function startRegisteredIntegrations(): void {
  for (const integration of getRegisteredIntegrations()) {
    try {
      integration.start();
      logger.info({ integration: integration.name }, 'Integration started');
    } catch (err) {
      logger.error(
        { err, integration: integration.name },
        'Integration failed to start',
      );
    }
  }
}

/** Stop every registered integration that supports it. */
export function stopRegisteredIntegrations(): void {
  for (const integration of getRegisteredIntegrations()) {
    try {
      integration.stop?.();
    } catch (err) {
      logger.error(
        { err, integration: integration.name },
        'Integration failed to stop',
      );
    }
  }
}
