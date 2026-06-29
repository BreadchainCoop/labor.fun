// Integration ("flow") self-registration barrel.
// Each import registers a background flow via registerIntegration(). The
// orchestrator calls startRegisteredIntegrations() once channels are up.
//
// Add an org- or app-specific flow by registering it here (or from a
// profile-supplied barrel). Each integration is responsible for checking its
// own config and no-op'ing when disabled. See docs/PLUGINS.md.

import { startGroupDigestLoop } from '../group-digest.js';
import { startDiscordMembersSyncLoop } from './discord-members-sync.js';
import { startGitHubProjectSyncLoop } from './github-project-sync.js';
import { registerIntegration } from './registry.js';
import { startSafePayoutsLoop, stopSafePayoutsLoop } from './safe-payouts.js';

registerIntegration({
  name: 'group-digest',
  start: () => startGroupDigestLoop(),
});

registerIntegration({
  name: 'github-project-sync',
  start: () => startGitHubProjectSyncLoop(),
});

registerIntegration({
  name: 'discord-members-sync',
  start: () => startDiscordMembersSyncLoop(),
});

registerIntegration({
  name: 'safe-payouts',
  start: () => startSafePayoutsLoop(),
  stop: () => stopSafePayoutsLoop(),
});
