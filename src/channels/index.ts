// Channel self-registration barrel file.
// Each import triggers the channel module's registerChannel() call.

// discord
import './discord.js';

// github (inbound @-mention trigger; opt-in via GITHUB_MENTIONS_ENABLED)
import './github.js';

// gmail

// slack
import './slack.js';

// telegram
import './telegram.js';

// whatsapp
