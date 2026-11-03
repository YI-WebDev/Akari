// Launches a headless Chromium for the screenshot / icon tools.
// Playwright's bundled Chromium does not start on every machine ("spawn UNKNOWN"),
// so fall back to the installed Chrome (CHROME_PATH or the default Windows path).

import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

export async function launchBrowser(opts = {}) {
  try {
    return await chromium.launch({ headless: true, ...opts });
  } catch (e) {
    if (!existsSync(CHROME)) throw e;
    return chromium.launch({ headless: true, ...opts, executablePath: CHROME });
  }
}
