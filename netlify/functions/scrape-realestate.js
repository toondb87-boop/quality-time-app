// netlify/functions/scrape-realestate.js
//
// Haalt live vastgoedaanbod op. Twee scraping-methodes worden gebruikt:
//
//  1) Gewone server-side fetch + cheerio (snel, licht) — voor ERA en We Invest
//     Antwerpen Zuidrand, die hun listings al in de kale HTML zetten.
//
//  2) Een ECHTE headless browser (puppeteer-core + @sparticuz/chromium) — voor
//     Immoweb, waarvan de listings pas via JavaScript in de pagina verschijnen
//     en dus met een gewone fetch nooit zichtbaar zijn. Dit is trager (een
//     paar seconden per pagina, want er wordt echt een browser opgestart) en
//     vraagt zwaardere dependencies, maar is de enige manier om zo'n site
//     alsnog uit te lezen.
//
// De Huisleverancier gaf een harde HTTP 403 terug op een gewone fetch. We
// proberen die nu OOK via de headless browser — als hun blokkade puur op
// "geen browser/JS" gebaseerd was, lukt het nu wel; blokkeren ze specifiek op
// IP-adres (Netlify's servers), dan blijft dit alsnog mislukken. Dat laatste
// kunnen we vanuit de code niet oplossen.

const cheerio = require('cheerio');
const chromium = require('@sparticuz/chromium-min');
const puppeteer = require('puppeteer-core');

// De -min variant bundelt Chromium NIET mee (dat gaf de "Cannot find module"-crash
// op Netlify) — in plaats daarvan wordt de browser bij de eerste aanroep gedownload
// vanaf deze URL, en daarna hergebruikt zolang de functie "warm" blijft.
const CHROMIUM_PACK_URL = 'https://github.com/Sparticuz/chromium/releases/download/v133.0.0/chromium-v133.0.0-pack.tar';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const FETCH_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'nl-BE,nl;q=0.9,en;q=0.8',
};

// ── Regio-slugs per bron. ──
const IMMOWEB_SLUGS = {
  'Borgerhout': 'borgerhout/2140',
  'Mortsel': 'mortsel/2640',
  'Edegem': 'edegem/2650',
  'Hove': 'hove/2540',
  'Boechout': 'boechout/2530',
  'Berchem': 'berchem/2600',
  '2018 Antwerpen': 'antwerpen-1/2018',
  'Kontich': 'kontich/2550',
  'Aartselaar': 'aartselaar/2630',
  'Wilrijk': 'wilrijk/2610',
  'Lint': 'lint/2547',
};

const ERA_SLUGS = {
  'Borgerhout': 'borgerhout',
  'Mortsel': 'mortsel',
  'Edegem': 'edegem',
  'Hove': 'hove',
  'Boechout': 'boechout',
  'Berchem': 'berchem',
  '2018 Antwerpen': 'antwerpen',
  'Kontich': 'kontich',
  'Aartselaar': 'aartselaar',
  'Wilrijk': 'wilrijk',
  'Lint': 'lint',
};

function timeoutFetch(url, ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return fetch(url, { headers: FETCH_HEADERS, signal: controller.signal })
    .finally(() => clearTimeout(t));
}

function parsePrice(txt) {
  if (!txt) return null;
  const m = txt.replace(/\u00a0/g, ' ').match(/€?\s?([\d]{1,3}(?:[.\s][\d]{3})+|\d{4,})/);
  if (!m) return null;
  return parseInt(m[1].replace(/[.\s]/g, ''), 10);
}

function makeId(bron, url) {
  return 'live-' + bron.toLowerCase().replace(/\s+/g, '') + '-' +
    Buffer.from(url).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function diag(html, matchedLinks, keptListings) {
  return {
    htmlLength: html ? html.length : 0,
    rawLinksFound: matchedLinks,
    listingsKept: keptListings,
  };
}

function findPriceBlock($, el) {
  let node = $(el);
  for (let level = 0; level < 8; level++) {
    const txt = node.text().replace(/\s+/g, ' ').trim();
    const prijs = parsePrice(txt);
    if (prijs && prijs >= 30000 && txt.length < 6000) {
      return { block: txt, prijs };
    }
    node = node.parent();
    if (!node || !node.length) break;
  }
  return null;
}

// De linktekst zelf is vaak enkel een generieke knoptekst ("Pand bekijken",
// "Bekijk details", ...) — niet bruikbaar als adres. De URL-slug bevat
// meestal wél een beschrijvende titel (bv. "instapklaar-appartement-antwerpen"),
// dus die wordt omgezet naar leesbare tekst en als beste gok gebruikt.
function titleFromSlug(url) {
  try {
    const path = new URL(url).pathname;
    const parts = path.split('/').filter(Boolean);
    const slug = parts[parts.length - 1] || '';
    if (!slug || /^\d+$/.test(slug)) return null; // louter een ID-nummer, geen titel
    const words = slug.replace(/[-_]+/g, ' ').trim();
    if (words.length < 4) return null;
    return words.charAt(0).toUpperCase() + words.slice(1);
  } catch (e) {
    return null;
  }
}

function extractFromBlock(block) {
  const kamersMatch = block.match(/(\d+)\s*(?:slaapkamer|kamer)/i);
  const oppMatch = block.match(/(\d+)\s*m²/);
  return {
    kamers: kamersMatch ? parseInt(kamersMatch[1], 10) : 0,
    opp: oppMatch ? parseInt(oppMatch[1], 10) : 0,
    tuin: /tuin/i.test(block),
  };
}

function dedupeByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    out.push(it);
  }
  return out;
}

// ── Gedeelde headless-browserinstantie voor deze functie-aanroep ──
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const executablePath = await chromium.executablePath(CHROMIUM_PACK_URL);
      return puppeteer.launch({
        args: await puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }),
        defaultViewport: chromium.defaultViewport,
        executablePath,
        headless: 'shell',
      });
    })();
  }
  return browserPromise;
}
async function closeBrowserIfOpen() {
  if (browserPromise) {
    try { const b = await browserPromise; await b.close(); } catch (e) {}
  }
}

async function fetchRenderedHtml(url, linkSelector, timeoutMs) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'nl-BE,nl;q=0.9,en;q=0.8' });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs });
    await page.waitForSelector(linkSelector, { timeout: Math.min(8000, timeoutMs) }).catch(() => {});
    const html = await page.content();
    return html;
  } finally {
    await page.close().catch(() => {});
  }
}

// ═══ IMMOWEB — via headless browser (JS-rendering vereist) ═══
async function scrapeImmoweb(regios) {
  const out = [];
  const diagnostics = [];
  for (const regio of regios) {
    const slug = IMMOWEB_SLUGS[regio];
    if (!slug) continue;
    const url = `https://www.immoweb.be/nl/zoeken/huis-en-appartement/te-koop/${slug}`;
    try {
      const html = await fetchRenderedHtml(url, 'a[href*="/nl/pand/"]', 18000);
      const $ = cheerio.load(html);
      const matches = $('a[href*="/nl/pand/"]');
      let kept = 0;

      matches.each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        const fullUrl = href.startsWith('http') ? href : `https://www.immoweb.be${href}`;
        const found = findPriceBlock($, el);
        if (!found) return;
        const extra = extractFromBlock(found.block);
        const adres = titleFromSlug(fullUrl) || ($(el).text() || '').replace(/\s+/g, ' ').trim().slice(0, 80) || found.block.slice(0, 60);

        out.push({
          id: makeId('Immoweb', fullUrl),
          adres: adres || regio,
          regio,
          prijs: found.prijs,
          kamers: extra.kamers,
          tuin: extra.tuin,
          opp: extra.opp,
          bron: 'Immoweb',
          url: fullUrl,
          datum: todayISO(),
          score: 0,
          gezien: false,
          icon: '🏘️',
          kleur: '#f5ede0',
        });
        kept++;
      });
      diagnostics.push(Object.assign({ regio, url }, diag(html, matches.length, kept)));
    } catch (e) {
      diagnostics.push({ regio, url, error: String(e && e.message || e) });
    }
  }
  return { items: dedupeByUrl(out).slice(0, 40), diagnostics };
}

// ═══ ERA — gewone fetch (werkt al) ═══
async function scrapeEra(regios) {
  const out = [];
  const diagnostics = [];
  for (const regio of regios) {
    const slug = ERA_SLUGS[regio];
    if (!slug) continue;
    for (const type of ['huis', 'appartement']) {
      const url = `https://www.era.be/nl/te-koop/${slug}/${type}`;
      let html = '';
      let rawLinks = 0;
      try {
        const res = await timeoutFetch(url, 9000);
        if (!res.ok) { diagnostics.push({ regio, type, url, httpStatus: res.status }); continue; }
        html = await res.text();
        const $ = cheerio.load(html);
        const matches = $('a[href*="/te-koop/"]').filter((_, el) => {
          const href = $(el).attr('href') || '';
          return href !== url && !href.endsWith(`/te-koop/${slug}`) && !href.endsWith('/te-koop');
        });
        rawLinks = matches.length;
        let kept = 0;

        matches.each((_, el) => {
          const href = $(el).attr('href');
          if (!href) return;
          const fullUrl = href.startsWith('http') ? href : `https://www.era.be${href}`;
          const found = findPriceBlock($, el);
          if (!found) return;
          const extra = extractFromBlock(found.block);
          const adres = titleFromSlug(fullUrl) || ($(el).text() || '').replace(/\s+/g, ' ').trim().slice(0, 80) || found.block.slice(0, 60);

          out.push({
            id: makeId('ERA', fullUrl),
            adres: adres || regio,
            regio,
            prijs: found.prijs,
            kamers: extra.kamers,
            tuin: extra.tuin,
            opp: extra.opp,
            bron: 'ERA',
            url: fullUrl,
            datum: todayISO(),
            score: 0,
            gezien: false,
            icon: '🏢',
            kleur: '#ece0d0',
          });
          kept++;
        });
        diagnostics.push(Object.assign({ regio, type, url }, diag(html, rawLinks, kept)));
      } catch (e) {
        diagnostics.push({ regio, type, url, error: String(e && e.message || e) });
      }
    }
  }
  return { items: dedupeByUrl(out).slice(0, 40), diagnostics };
}

// ═══ WE INVEST ANTWERPEN ZUIDRAND — gewone fetch (werkt al) ═══
async function scrapeWeInvest() {
  const out = [];
  const url = 'https://weinvest.be/nl-BE/agencies/antwerpen-zuidrand/50';
  try {
    const res = await timeoutFetch(url, 9000);
    if (!res.ok) return { items: out, diagnostics: [{ url, httpStatus: res.status }] };
    const html = await res.text();
    const $ = cheerio.load(html);
    const matches = $('a[href*="/nl-BE/property/"]');
    let kept = 0;

    matches.each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const fullUrl = href.startsWith('http') ? href : `https://weinvest.be${href}`;
      const found = findPriceBlock($, el);
      if (!found) return;
      const extra = extractFromBlock(found.block);
      const adres = titleFromSlug(fullUrl) || ($(el).text() || '').replace(/\s+/g, ' ').trim().slice(0, 80) || found.block.slice(0, 60);

      out.push({
        id: makeId('We Invest', fullUrl),
        adres: adres || 'Antwerpen Zuidrand',
        regio: 'Zuidrand (We Invest)',
        prijs: found.prijs,
        kamers: extra.kamers,
        tuin: extra.tuin,
        opp: extra.opp,
        bron: 'We Invest',
        url: fullUrl,
        datum: todayISO(),
        score: 0,
        gezien: false,
        icon: '🏡',
        kleur: '#f5ede0',
      });
      kept++;
    });
    return { items: dedupeByUrl(out).slice(0, 40), diagnostics: [Object.assign({ url }, diag(html, matches.length, kept))] };
  } catch (e) {
    return { items: out, diagnostics: [{ url, error: String(e && e.message || e) }] };
  }
}

// ═══ DE HUISLEVERANCIER — nogmaals proberen via headless browser ═══
// (gaf eerder HTTP 403 op een gewone fetch; onzeker of dit nu wél lukt)
async function scrapeHuisleverancier() {
  const out = [];
  const url = 'https://www.dehuisleverancier.be/te-koop/map?_locale=nl';
  try {
    const html = await fetchRenderedHtml(url, 'a[href*="/te-koop/"]', 15000);
    const $ = cheerio.load(html);
    const matches = $('a[href*="/te-koop/"]').filter((_, el) => {
      const href = $(el).attr('href') || '';
      return !href.endsWith('/te-koop/map');
    });
    let kept = 0;

    matches.each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const fullUrl = href.startsWith('http') ? href : `https://www.dehuisleverancier.be${href}`;
      const found = findPriceBlock($, el);
      if (!found) return;
      const extra = extractFromBlock(found.block);
      const adres = titleFromSlug(fullUrl) || ($(el).text() || '').replace(/\s+/g, ' ').trim().slice(0, 80) || found.block.slice(0, 60);

      out.push({
        id: makeId('De Huisleverancier', fullUrl),
        adres: adres || 'Zuidrand',
        regio: 'Kontich e.o. (De Huisleverancier)',
        prijs: found.prijs,
        kamers: extra.kamers,
        tuin: extra.tuin,
        opp: extra.opp,
        bron: 'De Huisleverancier',
        url: fullUrl,
        datum: todayISO(),
        score: 0,
        gezien: false,
        icon: '🏠',
        kleur: '#ece0d0',
      });
      kept++;
    });
    return { items: dedupeByUrl(out).slice(0, 40), diagnostics: [Object.assign({ url }, diag(html, matches.length, kept))] };
  } catch (e) {
    return { items: out, diagnostics: [{ url, error: String(e && e.message || e), note: 'Mogelijk IP-blokkade — headless browser lost dat niet op.' }] };
  }
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  try {
    const qs = event.queryStringParameters || {};
    const regios = (qs.regios || '').split(',').map(s => s.trim()).filter(Boolean);
    const effectiveRegios = regios.length ? regios : Object.keys(IMMOWEB_SLUGS);

    const results = await Promise.allSettled([
      scrapeImmoweb(effectiveRegios),
      scrapeEra(effectiveRegios),
      scrapeWeInvest(),
      scrapeHuisleverancier(),
    ]);

    await closeBrowserIfOpen();

    const bronnen = ['Immoweb', 'ERA', 'We Invest', 'De Huisleverancier'];
    const listings = [];
    const status = {};
    const debug = {};

    results.forEach((r, i) => {
      const naam = bronnen[i];
      if (r.status === 'fulfilled') {
        const { items, diagnostics } = r.value;
        listings.push(...items);
        status[naam] = { ok: true, count: items.length };
        debug[naam] = diagnostics;
      } else {
        status[naam] = { ok: false, error: String(r.reason && r.reason.message || r.reason) };
        debug[naam] = null;
      }
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        listings,
        status,
        debug,
        fetchedAt: new Date().toISOString(),
      }),
    };
  } catch (err) {
    await closeBrowserIfOpen();
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: String(err && err.message || err) }),
    };
  }
};
