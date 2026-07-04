/**
 * Knowledge-connector self-registration barrel.
 *
 * Each connector (Notion, Google Drive, …) is a source-specific module that
 * exports a `Connector` (see base.ts). This barrel wraps each one as an
 * `Integration` and registers it with the integrations registry, so a
 * connector's polling loop starts alongside the other background flows — but
 * only when it's env-configured (the loop no-ops otherwise). Imported from the
 * core integrations barrel (src/integrations/index.ts).
 *
 * To add a connector: implement a `Connector` in a new module here, then add a
 * `registerConnector(...)` call below. See docs/CONNECTORS.md.
 */

import { registerIntegration } from '../registry.js';
import { Connector, startConnectorLoop, stopConnectorLoop } from './base.js';
import { googleDriveConnector } from './google-drive.js';
import { notionConnector } from './notion.js';

/** Register one connector as a background integration keyed `connector:<name>`. */
export function registerConnector(connector: Connector): void {
  registerIntegration({
    name: `connector:${connector.name}`,
    start: () => startConnectorLoop(connector),
    stop: () => stopConnectorLoop(connector),
  });
}

registerConnector(notionConnector);
registerConnector(googleDriveConnector);
