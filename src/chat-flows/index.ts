/**
 * Chat-flow barrel. Importing this module registers every built-in chat flow
 * (each module self-registers via registerChatFlow, same pattern as channels
 * and integrations). Org-specific flows belong in `<profile>/plugins/` via
 * the PluginApi instead — see docs/PLUGINS.md.
 */
import './membership-intake.js';
