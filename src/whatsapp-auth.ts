/**
 * WhatsApp Authentication Script (interactive setup CLI).
 *
 * Run this during setup to authenticate with WhatsApp. Displays a QR code (or,
 * with --pairing-code, a phone pairing code), waits for the link, saves
 * credentials, then exits.
 *
 * The baileys connect/pairing logic lives in src/whatsapp-pairing.ts and is
 * shared with the hosted pairing broker (control-plane driven) — this file only
 * adds the terminal UX (QR rendering, prompts, status files).
 *
 * Usage: npx tsx src/whatsapp-auth.ts [--pairing-code --phone <number>]
 */
import fs from 'fs';
import path from 'path';
// @ts-expect-error no type declarations
import qrcode from 'qrcode-terminal';
import readline from 'readline';

import { STORE_DIR } from './config.js';
import { runPairingSession } from './whatsapp-pairing.js';

// Auth creds live at <STORE_DIR>/auth/creds.json — the same directory the
// running WhatsApp channel reads (src/channels/whatsapp.ts uses
// path.join(STORE_DIR, 'auth')). STORE_DIR is profile-aware (config.ts).
const AUTH_DIR = path.join(STORE_DIR, 'auth');
const QR_FILE = path.join(STORE_DIR, 'qr-data.txt');
const STATUS_FILE = path.join(STORE_DIR, 'auth-status.txt');

// Check for --pairing-code flag and phone number
const usePairingCode = process.argv.includes('--pairing-code');
const phoneArg = process.argv.find((_, i, arr) => arr[i - 1] === '--phone');

function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function authenticate(): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  // Clean up any stale QR/status files from previous runs
  try {
    fs.unlinkSync(QR_FILE);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(STATUS_FILE);
  } catch {
    /* ignore */
  }

  let phoneNumber = phoneArg;
  if (usePairingCode && !phoneNumber) {
    phoneNumber = await askQuestion(
      'Enter your phone number (with country code, no + or spaces, e.g. 14155551234): ',
    );
  }

  console.log('Starting WhatsApp authentication...\n');

  const session = await runPairingSession({
    authDir: AUTH_DIR,
    phone: usePairingCode ? phoneNumber : undefined,
    onQr: (qr) => {
      // Write raw QR data to file so the setup skill can render it.
      fs.writeFileSync(QR_FILE, qr);
      console.log('Scan this QR code with WhatsApp:\n');
      console.log('  1. Open WhatsApp on your phone');
      console.log('  2. Tap Settings → Linked Devices → Link a Device');
      console.log('  3. Point your camera at the QR code below\n');
      qrcode.generate(qr, { small: true });
    },
    onPairingCode: (code) => {
      console.log(`\n🔗 Your pairing code: ${code}\n`);
      console.log('  1. Open WhatsApp on your phone');
      console.log('  2. Tap Settings → Linked Devices → Link a Device');
      console.log('  3. Tap "Link with phone number instead"');
      console.log(`  4. Enter this code: ${code}\n`);
      fs.writeFileSync(STATUS_FILE, `pairing_code:${code}`);
    },
    onOpen: () => {
      fs.writeFileSync(STATUS_FILE, 'authenticated');
      try {
        fs.unlinkSync(QR_FILE);
      } catch {
        /* ignore */
      }
      console.log('\n✓ Successfully authenticated with WhatsApp!');
      console.log(`  Credentials saved to ${AUTH_DIR}/`);
      console.log('  You can now start the service.\n');
    },
    onClose: (reason) => {
      fs.writeFileSync(STATUS_FILE, `failed:${reason ?? 'unknown'}`);
      console.log('\n✗ Connection failed. Please try again.');
    },
  });

  // For pairing-code mode, request the first code after a short delay.
  if (usePairingCode && phoneNumber) {
    setTimeout(() => {
      session.requestPairingCode().catch((err) => {
        console.error('Failed to request pairing code:', err.message);
      });
    }, 3000);
  }

  const result = await session.done;
  session.close();
  if (result === 'authenticated') {
    // Give it a moment for the final creds flush, then exit clean.
    setTimeout(() => process.exit(0), 500);
  } else {
    process.exit(1);
  }
}

authenticate().catch((err) => {
  console.error('Authentication failed:', err.message);
  process.exit(1);
});
