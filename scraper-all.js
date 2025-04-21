#!/usr/bin/env node
import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { getListOfCountries } from './src/scraper/services/countries/index.js';
import { getListOfLeagues } from './src/scraper/services/leagues/index.js';

// === CONFIG ===
const DEFAULT_TIMEOUT   = 3000;   // ms for league table selectors
const CUP_TIMEOUT       = 2000;   // ms for cup/knockout tournaments
const REQUEST_PAUSE     = 1000;   // ms between league fetches

// === HELPERS ===
const slug  = url => url.replace(/\/+$/, '').split('/').pop();
const toUSA = url => url.replace('flashscore.com', 'flashscoreusa.com');
const isCup = url => /cup|copa|trophy|shield|knockout/i.test(url);

async function fetchTeams(browser, leagueUrl) {
  const page = await browser.newPage();
  const timeout = isCup(leagueUrl) ? CUP_TIMEOUT : DEFAULT_TIMEOUT;
  try {
    console.log(`→ fetching teams for: ${leagueUrl}`);
    const standings = leagueUrl.replace(/\/+$/, '') + '/standings';
    await page.goto(standings, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('a[href*="/team/"]', { timeout });

    const teams = await page.evaluate(() => {
      const map = new Map();
      document.querySelectorAll('a[href*="/team/"]').forEach(a => {
        const m = a.href.match(/\/team\/[^\/]+\/([^\/?#]+)/);
        const name = a.innerText.trim();
        if (m && name && !map.has(m[1])) map.set(m[1], { name, id: m[1], url: a.href });
      });
      return Array.from(map.values());
    });

    console.log(`✅ found ${teams.length} teams`);
    return teams;
  } catch (e) {
    console.warn(`⚠ no teams for ${leagueUrl} (${e.message})`);
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
    output[key] = output[key] || { slug: slug(country.url), url: country.url, urlUSA: toUSA(country.url), leagues: {} };

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
      let teams = [];
      for (let i = 1; i <= 2; i++) {
        teams = await fetchTeams(browser, league.url);
        if (teams.length) break;
        console.log(`     ↩ retry ${league.name} #${i}`);
      }

      output[key].leagues[league.name] = { slug: slug(league.url), url: league.url, urlUSA: toUSA(league.url), teams };
      totalTeams += teams.length;
      await fs.writeFile(temp, JSON.stringify(output, null, 2));
      await new Promise(r => setTimeout(r, REQUEST_PAUSE));
    }

    console.log(`✅ ${country.name}: ${totalTeams} teams across ${Object.keys(output[key].leagues).length} leagues`);
  }

  await browser.close();
  await fs.writeFile(finalF, JSON.stringify(output, null, 2));
  console.log(`\n🎉 Completed in ${((performance.now() - start)/1000).toFixed(1)}s → ${finalF}`);
})();
