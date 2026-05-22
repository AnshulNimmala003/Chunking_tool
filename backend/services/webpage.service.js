const path = require('path');
const { v4: uuidv4 } = require('uuid');

/**
 * Auto-scroll the page to trigger lazy-loaded content.
 */
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let totalHeight = 0;
      const distance = 400;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= Math.min(document.body.scrollHeight, 8000)) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 120);
    });
  });
}

/**
 * Screenshot a public URL using Puppeteer.
 * Returns { imagePath (filename), imageUrl (/uploads/...), title }.
 */
async function screenshotUrl(url, uploadsDir) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    throw new Error(
      'puppeteer is not installed. Run: cd backend && npm install puppeteer'
    );
  }

  const filename = `${uuidv4()}_webpage.jpg`;
  const outputPath = path.join(uploadsDir, filename);

  console.log(`  [Webpage] Launching Chromium for: ${url}`);
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  let title = url;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await autoScroll(page);
    title = await page.title().catch(() => url);

    // Take full-page screenshot; cap at 15000px tall to stay within Gemini limits
    const fullHeight = await page.evaluate(() => document.body.scrollHeight);
    const capHeight  = Math.min(fullHeight, 15000);
    await page.setViewport({ width: 1440, height: capHeight, deviceScaleFactor: 1.5 });

    await page.screenshot({
      path: outputPath,
      type: 'jpeg',
      quality: 88,
      fullPage: false   // viewport-only after resize avoids Puppeteer memory issues
    });

    console.log(`  [Webpage] Screenshot saved: ${filename}`);
  } finally {
    await browser.close();
  }

  return { filename, imageUrl: `/uploads/${filename}`, title };
}

module.exports = { screenshotUrl };
