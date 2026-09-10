import { basename } from 'node:path';
import puppeteer from 'puppeteer-core';

export function browserType(executablePath = process.env.BROWSER_EXECUTABLE_PATH) {
  return executablePath && /firefox/i.test(basename(executablePath)) ? 'firefox' : 'chrome';
}

export function launchBrowser(userDataDir?: string, headless = true) {
  const executablePath = process.env.BROWSER_EXECUTABLE_PATH;
  const browser = browserType(executablePath);
  return puppeteer.launch({
    browser,
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    userDataDir,
    headless,
    defaultViewport: { width: 1440, height: 1000 },
    ...(browser === 'firefox'
      ? { extraPrefsFirefox: { 'intl.accept_languages': 'en-US,en' } }
      : { args: ['--lang=en-US'] }),
  });
}
