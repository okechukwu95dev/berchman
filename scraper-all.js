#!/usr/bin/env node
import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';

// === CONFIG ===
const DEFAULT_TIMEOUT = 5000;
const CUP_TIMEOUT     = 3000;
const REQUEST_PAUSE   = 1500;
const OUTPUT_DIR      = './data';

// Simple logger (no backticks → no SyntaxErrors)
function log(msg) {
  console.log('[' + new Date().toISOString() + '] ' + msg);
}

// Helpers
const slug  = url => url.replace(/\/+$/, '').split('/').pop();
const toUSA = url => url.replace('flashscore.com', 'flashscoreusa.com');
const isCup = url => /cup|copa|trophy|shield|knockout/i.test(url);

// 1️⃣ Get list of countries
async function getListOfCountries(browser) {
  log('ENTER ▶ getListOfCountries');
  const page = await browser.newPage();
  try {
    log('→ opening https://www.flashscore.com');
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    await page.goto('https://www.flashscore.com', { waitUntil: 'domcontentloaded', timeout: 30000 });

    log('→ clicking country menu');
    await page.waitForSelector('#category-left-menu > div > span', { timeout: DEFAULT_TIMEOUT });
    await page.click('#category-left-menu > div > span');

    log('→ waiting for country items');
    await page.waitForSelector('[id^="country_"]', { timeout: DEFAULT_TIMEOUT });

    const countries = await page.evaluate(function() {
      const els = Array.from(document.querySelectorAll('[id^="country_"]'));
      return els.map(function(el) {
        const name = el.querySelector('span') && el.querySelector('span').innerText.trim();
        const id   = el.id;
        const url  = window.location.origin + '/' + el.getAttribute('data-tournament-url');
        return { id: id, name: name, url: url };
      });
    });

    log('FOUND ' + countries.length + ' countries');
    return countries;

  } catch (err) {
    console.error('ERROR ❌ getListOfCountries →', err.message);
    throw err;            // stop on failure so CI fails early
  } finally {
    await page.close();
    log('EXIT ◀ getListOfCountries');
  }
}

// 2️⃣ Get list of leagues for one country
async function getListOfLeagues(browser, country) {
  log('ENTER ▶ getListOfLeagues(' + country.name + ')');
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    await page.goto('https://www.flashscore.com', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await page.waitForSelector('#category-left-menu > div > span', { timeout: DEFAULT_TIMEOUT });
    await page.click('#category-left-menu > div > span');

    await page.waitForSelector('#' + country.id, { timeout: DEFAULT_TIMEOUT });
    await page.click('#' + country.id);

    await page.waitForSelector('#' + country.id + ' ~ span > a', { timeout: DEFAULT_TIMEOUT });

    const leagues = await page.evaluate(function(cId) {
      return Array.from(document.querySelectorAll('#' + cId + ' ~ span > a')).map(function(a) {
        return { name: a.innerText.trim(), url: a.href };
      });
    }, country.id);

    log('FOUND ' + leagues.length + ' leagues for ' + country.name);
    return leagues;

  } catch (err) {
    console.warn('WARN ⚠ getListOfLeagues(' + country.name + ') →', err.message);
    return [];
  } finally {
    await page.close();
    log('EXIT ◀ getListOfLeagues');
  }
}

// 3️⃣ Fetch teams for a single league
async function fetchTeams(browser, league) {
  log('ENTER ▶ fetchTeams(' + league.name + ')');
  const page = await browser.newPage();
  const timeout = isCup(league.url) ? CUP_TIMEOUT : DEFAULT_TIMEOUT;
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    const standingsUrl = league.url.replace(/\/+$/, '') + '/standings';
    log('→ goto ' + standingsUrl);
    await page.goto(standingsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    await page.waitForSelector('a[href*="/team/"]', { timeout: timeout });

    const teams = await page.evaluate(function() {
      const map = new Map();
      document.querySelectorAll('a[href*="/team/"]').forEach(function(a) {
        const m = a.href.match(/\/team\/[^\/]+\/([^\/?#]+)/);
        const n = a.innerText.trim();
        if (m && n && !map.has(m[1])) {
          map.set(m[1], { name: n, id: m[1], url: a.href });
        }
      });
      return Array.from(map.values());
    });

    log('FOUND ' + teams.length + ' teams for ' + league.name);
    return teams;

  } catch (err) {
    console.warn('WARN ⚠ fetchTeams(' + league.name + ') →', err.message);
    return isCup(league.url) ? [{ name: 'isCup', id: 'isCup', url: null }] : [];
  } finally {
    await page.close();
    log('EXIT ◀ fetchTeams');
  }
}

// 4️⃣ Main
(async function main() {
  const start = performance.now();
  log('🚀 STARTING scraper');

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const ts = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const tempFile  = path.join(OUTPUT_DIR, 'flashscore-temp-' + ts + '.json');
  const finalFile = path.join(OUTPUT_DIR, 'flashscore-final-' + ts + '.json');

  let output = {};
  if (existsSync(tempFile)) {
    log('⚡ loading checkpoint ' + tempFile);
    output = JSON.parse(await fs.readFile(tempFile, 'utf8'));
  }

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const countries = await getListOfCountries(browser);
    for (const country of countries) {
      log('---- COUNTRY: ' + country.name);
      if (!output[country.name]) {
        output[country.name] = { slug: slug(country.url), url: country.url, leagues: {} };
      }
      const leagues = await getListOfLeagues(browser, country);
      for (const league of leagues) {
        if (output[country.name].leagues[league.name]?.teams?.length) {
          log(' SKIP league (cached): ' + league.name);
          continue;
        }
        log(' → LEAGUE: ' + league.name);
        let teams = [];
        for (let i=1; i<=2; i++) {
          teams = await fetchTeams(browser, league);
          if (teams.length) break;
          log('  RETRY league ' + league.name + ' #' + i);
        }
        output[country.name].leagues[league.name] = { slug: slug(league.url), url: league.url, teams: teams };
        await fs.writeFile(tempFile, JSON.stringify(output,null,2));
        await new Promise(r=>setTimeout(r, REQUEST_PAUSE));
      }
    }
    await fs.writeFile(finalFile, JSON.stringify(output,null,2));
    log('🎉 DONE in ' + ((performance.now()-start)/1000).toFixed(1) + 's → ' + finalFile);

  } catch (err) {
    console.error('❌ FATAL:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
