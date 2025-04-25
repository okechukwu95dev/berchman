#!/usr/bin/env node
import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';

// ─── Helpers ────────────────────────────────────────────────────
function parseDate(dateStr) {
  const m = dateStr.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}:\d{2})/);
  if (m) {
    const [ , d, M, Y, t ] = m;
    return new Date(`${Y}-${M.padStart(2,'0')}-${d.padStart(2,'0')}T${t}:00`);
  }
  return new Date(dateStr);
}

// ─── Process a batch of matches ────────────────────────────────
async function processBatch(batchFile) {
  console.log(`🔄 Processing batch: ${batchFile}`);

  // Load batch file
  const batchPath = path.join(process.cwd(), 'batches', batchFile);
  const ids = JSON.parse(await fs.readFile(batchPath, 'utf8'));

  const fixes = {};
  const blocked = [];

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  const page = await browser.newPage();

  // Optimize page loading
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    // Skip images, fonts and stylesheets to speed up loading
    const resourceType = req.resourceType();
    if (['image', 'font', 'stylesheet'].includes(resourceType)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  // Set viewport and user agent
  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36');

  // Accept cookies once
  console.log('Handling initial cookie popup...');
  await page.goto('https://www.flashscore.com', {
    waitUntil: 'domcontentloaded',
    timeout: 20000
  });

  // Handle popup
  try {
    const popupSelector = '#onetrust-accept-btn-handler';
    const popupExists = await page.$(popupSelector);
    if (popupExists) {
      console.log(`Found popup: ${popupSelector}`);
      await page.click(popupSelector).catch(e => console.log(`Click error: ${e.message}`));
      await page.waitForTimeout(1000);
    }
  } catch (e) {
    console.log('Popup handling error (continuing anyway):', e.message);
  }

  console.log(`Processing ${ids.length} IDs in batch...`);
  for (let i = 0; i < ids.length; i++) {
    const matchId = ids[i];
    const url = `https://www.flashscore.com/match/${matchId}/#/match-summary`;

    try {
      console.log(`[${i+1}/${ids.length}] Processing ${matchId}...`);

      // Navigate to match page
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });

      // Wait for date element
      await page.waitForSelector('.duelParticipant__startTime, .duelParticipant__time', {
        timeout: 5000
      }).catch(() => console.log('Warning: Date element not immediately found'));

      // Extract date
      const dateStr = await page.evaluate(() => {
        const selectors = [
          '.duelParticipant__startTime div',
          '.duelParticipant__time',
          '.duelParticipant__startTime'
        ];

        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el && el.textContent) {
            return el.textContent.trim();
          }
        }
        return null;
      });

      if (!dateStr) {
        throw new Error('Could not find date on page');
      }

      const dt = parseDate(dateStr);
      if (isNaN(dt)) throw new Error(`Invalid date: "${dateStr}"`);

      fixes[matchId] = dt.toISOString();
      console.log(`✅ ${matchId} → ${dt.toISOString()}`);
    } catch (err) {
      console.warn(`⚠️ ${matchId} failed: ${err.message}`);
      blocked.push(matchId);
    }

    // Small delay between requests
    if (i < ids.length - 1) {
      const delay = 1000 + Math.random() * 1000; // 1-2 second random delay
      await page.waitForTimeout(delay);
    }
  }

  // Write batch results
  const batchId = parseInt(batchFile.match(/batch_(\d+)_of/)?.[1] || '0');
  const outputDir = path.join(process.cwd(), 'results');
  await fs.mkdir(outputDir, { recursive: true });

  const resultFile = path.join(outputDir, `results_batch_${batchId}.json`);
  await fs.writeFile(resultFile, JSON.stringify({ fixes, blocked }, null, 2));

  console.log(`Batch completed. ${Object.keys(fixes).length} fixed, ${blocked.length} blocked.`);
  await browser.close();

  return { fixes, blocked };
}

// ─── Merge all results into final output ────────────────────────
async function mergeResults() {
  console.log('Merging all batch results...');

  const resultsDir = path.join(process.cwd(), 'results');
  const resultFiles = await fs.readdir(resultsDir).catch(() => []);

  if (!resultFiles.length) {
    console.log('No results to merge.');
    return;
  }

  const allFixes = {};
  const allBlocked = [];

  for (const file of resultFiles) {
    if (!file.startsWith('results_batch_')) continue;

    try {
      const filePath = path.join(resultsDir, file);
      const { fixes, blocked } = JSON.parse(await fs.readFile(filePath, 'utf8'));

      Object.assign(allFixes, fixes);
      allBlocked.push(...blocked);

      console.log(`Merged ${file}: ${Object.keys(fixes).length} fixes, ${blocked.length} blocked.`);
    } catch (err) {
      console.warn(`Error processing ${file}: ${err.message}`);
    }
  }

  // Write final outputs
  await fs.writeFile('dateFixes.json', JSON.stringify(allFixes, null, 2));
  await fs.writeFile('blocked.json', JSON.stringify(allBlocked, null, 2));

  console.log(`✅ Merge complete. Total: ${Object.keys(allFixes).length} fixed, ${allBlocked.length} blocked.`);
}

// ─── Main function ─────────────────────────────────────────────
async function main() {
  const command = process.argv[2];
  const param = process.argv[3];

  if (command === 'process' && param) {
    await processBatch(param);
  } else if (command === 'merge') {
    await mergeResults();
  } else {
    console.log(`
Usage:
  node fix-match-dates.js process <batch_file>  - Process a specific batch
  node fix-match-dates.js merge                 - Merge all results
    `);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
