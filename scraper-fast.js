#!/usr/bin/env node
import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { getListOfCountries } from './src/scraper/services/countries/index.js';
import { getListOfLeagues } from './src/scraper/services/leagues/index.js';

// === CONFIG ===
const DEFAULT_TIMEOUT   = 1000;   // ms for league table selectors
const CUP_TIMEOUT       = 500;   // ms for cup/knockout tournaments
const REQUEST_PAUSE     = 500;   // ms between league fetches

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

  console.log(`→ Navigating to standings page: ${standings}`);
  await page.goto(standings, {
    waitUntil: 'networkidle2',
    timeout:   30000
  });
  console.log(`→ Final URL: ${page.url()}`);

  // Dismiss cookie banner if present
  try {
    await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 5000 });
    await page.click('#onetrust-accept-btn-handler');
    console.log('✅ Cookie banner dismissed');
    await page.waitForTimeout(1000);
  } catch {
    console.log('⚠️ No cookie banner found');
  }

  // Dump HTML & screenshot for debugging
  const slugSuffix = cleanUrl.split('/').slice(-1)[0].replace(/[^a-z0-9]/gi, '_');
  const htmlPath   = path.join('data', `debug-${slugSuffix}.html`);
  const pngPath    = path.join('data', `debug-${slugSuffix}.png`);
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile(htmlPath, await page.content(), 'utf8');
  await page.screenshot({ path: pngPath, fullPage: true });
  console.log(`📄 Debug dump written: ${htmlPath}, ${pngPath}`);

  try {
    console.log(`→ Waiting for team links (timeout ${timeout}ms)`);
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

    console.log(`✅ Found ${teams.length} teams`);
    return teams;

  } catch (e) {
    console.warn(`⚠ No teams for ${leagueUrl} → ${e.message}`);
    return [];
  } finally {
    await page.close();
  }
}

(async () => {
  const start = performance.now();
  console.log('🚀 Starting FlashScore scraper using service modules');

  // prepare output paths
  const ts     = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const temp   = `./flashscore-temp-${ts}.json`;
  const finalF = `./flashscore-final-${ts}.json`;
  let output   = {};

  if (existsSync(temp)) {
    console.log(`⚡ loading checkpoint ${temp}`);
    try { output = JSON.parse(await fs.readFile(temp, 'utf8')); } catch {}
  }

  const browser   = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const countries = await getListOfCountries(browser);
  console.log(`🌍 Total countries: ${countries.length}`);

  for (const country of countries) {
    console.log(`\n🔹 Processing country: ${country.name}`);
    const key = country.name;
    output[key] = output[key] || {
      slug: slug(country.url),
      url: country.url,
      urlUSA: toUSA(country.url),
      leagues: {}
    };

    const leagues = await getListOfLeagues(browser, country.id);
    console.log(`→ fetched ${leagues.length} leagues for ${country.name}`);

    let totalTeams = 0;
    for (const league of leagues) {
      if (output[key].leagues[league.name]?.teams?.length) {
        console.log(`   ✓ skip cached league: ${league.name}`);
        totalTeams += output[key].leagues[league.name].teams.length;
        continue;
      }

      console.log(`   → league: ${league.name}`);
      const teams = await fetchTeams(browser, league.url);
      output[key].leagues[league.name] = {
        slug: slug(league.url),
        url: league.url,
        urlUSA: toUSA(league.url),
        teams
      };
      totalTeams += teams.length;

      // checkpoint after each league
      await fs.writeFile(temp, JSON.stringify(output, null, 2));
      await new Promise(r => setTimeout(r, REQUEST_PAUSE));
    }

    console.log(
      `✅ ${country.name}: ${totalTeams} teams across ${Object.keys(
        output[key].leagues
      ).length} leagues`
    );
  }

  await browser.close();
  await fs.writeFile(finalF, JSON.stringify(output, null, 2));
  console.log(
    `\n🎉 Completed in ${((performance.now() - start) / 1000).toFixed(
      1
    )}s → ${finalF}`
  );
})();
