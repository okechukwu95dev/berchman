#!/usr/bin/env node
import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { getListOfCountries } from './src/scraper/services/countries/index.js';
import { getListOfLeagues } from './src/scraper/services/leagues/index.js';

// === CONFIG ===
const DEFAULT_TIMEOUT   = 1500;   // ms for league table selectors (faster)
const CUP_TIMEOUT       = 1000;   // ms for cup tournaments
const REQUEST_PAUSE     = 0;      // no pause between leagues (test mode)

// === HELPERS ===
const slug  = url => url.replace(/\/+$/, '').split('/').pop();
const toUSA = url => url.replace('flashscore.com', 'flashscoreusa.com');
const isCup = url => /cup|copa|trophy|shield|knockout/i.test(url);

// Fetch teams for a given league URL
async function fetchTeams(browser, leagueUrl) {
  const page      = await browser.newPage();
  const timeout   = isCup(leagueUrl) ? CUP_TIMEOUT : DEFAULT_TIMEOUT;
  const cleanUrl  = leagueUrl.replace(/\/+$/, '');
  const standings = `${cleanUrl}/standings/`;

  console.log(`→ Navigating to: ${standings}`);
  await page.goto(standings, { waitUntil: 'networkidle2', timeout: 30000 });
  console.log(`→ Landed at: ${page.url()}`);

  // Dismiss cookie banner if present
  try {
    await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 5000 });
    await page.click('#onetrust-accept-btn-handler');
    console.log('✅ Cookie dismissed');
    await page.waitForTimeout(500);
  } catch {
    console.log('⚠ No cookie banner');
  }

  // Wait for team links
  try {
    console.log(`→ Waiting for teams (timeout ${timeout}ms)`);
    await page.waitForSelector('a[href*="/team/"]', { timeout });
    const teams = await page.evaluate(() => {
      const map = new Map();
      document.querySelectorAll('a[href*="/team/"]').forEach(a => {
        const m = a.href.match(/\/team\/[^\/]+\/([^\/?#]+)/);
        const name = a.innerText.trim();
        if (m && name && !map.has(m[1])) {
          map.set(m[1], { name, id: m[1], url: a.href });
        }
      });
      return [...map.values()];
    });

    console.log(`✅ ${teams.length} teams`);
    return teams;

  } catch (e) {
    console.warn(`⚠ No teams for ${leagueUrl}: ${e.message}`);
    return [];
  } finally {
    await page.close();
  }
}

(async () => {
  const start = performance.now();
  console.log('🚀 Test-run: FlashScore scraper (with final file)');

  // Prepare paths
  const ts     = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const temp   = `./flashscore-temp-test-${ts}.json`;
  const final  = `./flashscore-final-test-${ts}.json`;
  let output   = {};

  // Load checkpoint
  if (existsSync(temp)) {
    console.log(`⚡ Loading checkpoint: ${temp}`);
    try { output = JSON.parse(await fs.readFile(temp, 'utf8')); } catch {}
  }

  // Launch browser
  const browser   = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const countries = await getListOfCountries(browser);
  console.log(`🌍 Countries: ${countries.length}`);

  for (const country of countries) {
    console.log(`\n🔹 Country: ${country.name}`);
    // Initialize country entry with all fields
    output[country.name] = output[country.name] || {
      slug:   slug(country.url),
      url:    country.url,
      urlUSA: toUSA(country.url),
      leagues: {}
    };

    // Get leagues
    const leagues = await getListOfLeagues(browser, country.id);
    console.log(`→ Leagues: ${leagues.length}`);

    for (const league of leagues) {
      console.log(`   → League: ${league.name}`);
      const teams = await fetchTeams(browser, league.url);
      // Save full league object
      output[country.name].leagues[league.name] = {
        slug:   slug(league.url),
        url:    league.url,
        urlUSA: toUSA(league.url),
        teams
      };
      // Checkpoint write
      await fs.writeFile(temp, JSON.stringify(output, null, 2));
    }
  }

  // Close and write final
  await browser.close();
  await fs.writeFile(final, JSON.stringify(output, null, 2));
  const duration = ((performance.now() - start) / 1000).toFixed(1);
  console.log(`🎉 Test done in ${duration}s`);
  console.log(`📂 Final file: ${final}`);
})();
