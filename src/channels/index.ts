// Channel self-registration barrel file.
// Each import triggers the channel module's registerChannel() call.

// discord
import './discord.js';

// github (inbound @-mention trigger; opt-in via GITHUB_MENTIONS_ENABLED)
import './github.js';

// gmail

// signal (signal-cli JSON-RPC daemon; opt-in via SIGNAL_ACCOUNT)
import './signal.js';

// slack
import './slack.js';

// telegram
import './telegram.js';

// web (browser chat widget; opt-in via WEB_WIDGET_ENABLED)
import './web.js';

// whatsapp
