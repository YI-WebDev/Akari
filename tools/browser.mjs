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
