/**
 * Minimal IMAP poller for Breadbrich Engels's email.
 * Checks for new mail from whitelisted senders, routes them as messages.
 */
import { ImapFlow } from 'imapflow';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const emailEnv = readEnvFile(['BREADBRICH_EMAIL', 'BREADBRICH_EMAIL_PASSWORD']);

const EMAIL_WHITELIST = (process.env.EMAIL_WHITELIST || '')
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean);

if (EMAIL_WHITELIST.length === 0) {
  logger.warn('EMAIL_WHITELIST not set — inbound emails will be rejected');
}

const POLL_INTERVAL = 60_000; // 1 minute

interface EmailPollerDeps {
  onEmail: (from: string, subject: string, body: string) => Promise<void>;
}

let pollerRunning = false;

export async function startEmailPoller(deps: EmailPollerDeps): Promise<void> {
  const user = process.env.BREADBRICH_EMAIL || emailEnv.BREADBRICH_EMAIL;
  const pass =
    process.env.BREADBRICH_EMAIL_PASSWORD || emailEnv.BREADBRICH_EMAIL_PASSWORD;

  if (!user || !pass) {
    logger.warn(
      'BREADBRICH_EMAIL or BREADBRICH_EMAIL_PASSWORD not configured — email poller disabled',
    );
    return;
  }

  if (pollerRunning) return;
  pollerRunning = true;

  logger.info({ user }, 'Email poller starting');

  const poll = async () => {
    let client: ImapFlow | null = null;
    try {
      client = new ImapFlow({
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        auth: { user, pass },
        logger: false,
      });

      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        // Fetch unseen messages
        const messages = client.fetch(
          { seen: false },
          {
            envelope: true,
            source: true,
          },
        );

        for await (const msg of messages) {
          const from = msg.envelope?.from?.[0]?.address?.toLowerCase() || '';
          const subject = msg.envelope?.subject || '(no subject)';

          if (!EMAIL_WHITELIST.includes(from)) {
            logger.info(
              { from, subject },
              'Email from non-whitelisted sender — skipping',
            );
            // Mark as seen so we don't re-process
            await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
            continue;
          }

          // Extract plain text body
          let body = '';
          if (msg.source) {
            const raw = msg.source.toString();
            // Simple plain text extraction — find text after headers
            const bodyStart = raw.indexOf('\r\n\r\n');
            if (bodyStart !== -1) {
              body = raw.slice(bodyStart + 4);
              // Strip MIME boundaries if present
              if (body.includes('Content-Type:')) {
                const textMatch = body.match(
                  /Content-Type: text\/plain[^\r\n]*\r\n(?:Content-Transfer-Encoding:[^\r\n]*\r\n)?\r\n([\s\S]*?)(?:\r\n--|\s*$)/i,
                );
                if (textMatch) body = textMatch[1];
              }
              body = body.trim().slice(0, 2000); // Cap length
            }
          }

          logger.info(
            { from, subject },
            'Email received from whitelisted sender',
          );
          await deps.onEmail(from, subject, body);

          // Mark as seen
          await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
        }
      } finally {
        lock.release();
      }

      await client.logout();
    } catch (err) {
      logger.error({ err }, 'Email poller error');
      try {
        await client?.logout();
      } catch {
        /* ignore */
      }
    }
  };

  // Initial poll
  await poll();

  // Schedule recurring polls
  setInterval(poll, POLL_INTERVAL);
}
