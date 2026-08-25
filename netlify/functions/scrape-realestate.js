// netlify/functions/scrape-realestate.js
//
// Haalt live vastgoedaanbod op bij de bronnen waarvan we hebben geverifieerd
// dat ze (op het moment van schrijven) geen bot-bescherming hebben die een
// server-side fetch blokkeert: Immoweb, ERA, We Invest Antwerpen Zuidrand en
// De Huisleverancier (Kontich). Zimmo, Immovlan, Century21 (zoekpagina) en
// Realo blokkeren server-side requests of leveren enkel JS-gerenderde content
// — die worden bewust NIET geprobeerd, om geen tijd te verspillen aan calls
// die toch altijd leeg terugkomen.
//
// Belangrijk: dit is best-effort HTML-scraping van publiek zichtbare pagina's.
// Sites kunnen hun markup op elk moment wijzigen, waardoor een bron plots
// 0 resultaten geeft terwijl de site zelf wel degelijk aanbod heeft. Elke
// bron faalt dus onafhankelijk van de andere (Promise.allSettled) zodat 1
// kapotte bron nooit de andere 3 blokkeert.

const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const FETCH_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'nl-BE,nl;q=0.9,en;q=0.8',
};

// ── Regio-slugs per bron. Alleen regio's die de gebruiker effectief kan
// aanvinken in de app-filter worden hier gemapt; onbekende regio's worden
// overgeslagen voor die bron (geen crash, gewoon minder resultaten).
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

function parseInt0(txt) {
  if (!txt) return 0;
  const m = String(txt).match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

function makeId(bron, url) {
  return 'live-' + bron.toLowerCase().replace(/\s+/g, '') + '-' +
    Buffer.from(url).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Loopt van het <a>-element omhoog door tot 5 ouder-niveaus, tot een blok
// tekst gevonden wordt met een geldige prijs erin. Robuuster dan 1x
// closest('article,li,div'), want elke site verpakt kaarten anders.
function findPriceBlock($, el) {
  let node = $(el);
  for (let level = 0; level < 5; level++) {
    const txt = node.text().replace(/\s+/g, ' ').trim();
    const prijs = parsePrice(txt);
    if (prijs && prijs >= 30000 && txt.length < 4000) {
      return { block: txt, prijs };
    }
    node = node.parent();
    if (!node || !node.length) break;
  }
  return null;
}

function diag(html, matchedLinks, keptListings) {
  return {
    htmlLength: html ? html.length : 0,
    looksLikeCookieWall: !!(html && /cookie|consent|toestemming/i.test(html.slice(0, 3000))),
    rawLinksFound: matchedLinks,
    listingsKept: keptListings,
  };
}

// ═══ IMMOWEB ═══
// UITGESCHAKELD: uit live diagnostiek bleek dat Immoweb's listings enkel via
// JavaScript in de browser opgebouwd worden — een server-side fetch krijgt
// een lege pagina-shell (2,8MB aan JS, 0 pand-links in de ruwe HTML) terug.
// Zonder een echte browser (headless Chrome) is dit niet op te lossen.
async function scrapeImmoweb(regios) {
  return { items: [], diagnostics: [{ info: 'Immoweb overgeslagen — vereist JavaScript-rendering, niet haalbaar via server-side fetch.' }] };
}

// ═══ ERA ═══
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
          // sluit navigatie-/filterlinks uit (die eindigen exact op de regio/type-pagina zelf)
          return href !== url && !href.endsWith(`/te-koop/${slug}`) && !href.endsWith('/te-koop');
        });
        rawLinks = matches.length;

        matches.each((_, el) => {
          const href = $(el).attr('href');
          if (!href) return;
          const fullUrl = href.startsWith('http') ? href : `https://www.era.be${href}`;
          const found = findPriceBlock($, el);
          if (!found) return;

          const kamersMatch = found.block.match(/(\d+)\s*(?:slaapkamer|kamer)/i);
          const oppMatch = found.block.match(/(\d+)\s*m²/);
          const adres = ($(el).text() || '').replace(/\s+/g, ' ').trim().slice(0, 80) || found.block.slice(0, 60);

          out.push({
            id: makeId('ERA', fullUrl),
            adres: adres || regio,
            regio,
            prijs: found.prijs,
            kamers: kamersMatch ? parseInt(kamersMatch[1], 10) : 0,
            tuin: /tuin/i.test(found.block),
            opp: oppMatch ? parseInt(oppMatch[1], 10) : 0,
            bron: 'ERA',
            url: fullUrl,
            datum: todayISO(),
            score: 0,
            gezien: false,
            icon: '🏢',
            kleur: '#ece0d0',
          });
        });
        diagnostics.push(Object.assign({ regio, type, url }, diag(html, rawLinks, out.length)));
      } catch (e) {
        diagnostics.push({ regio, type, url, error: String(e && e.message || e) });
      }
    }
  }
  return { items: dedupeByUrl(out).slice(0, 40), diagnostics };
}

// ═══ WE INVEST ANTWERPEN ZUIDRAND ═══
// Dit kantoor dekt exact de Zuidrand-gemeenten, dus we halen gewoon hun hele
// "te koop"-aanbod op zonder per-regio te filteren op URL-niveau — het
// filteren op regio gebeurt client-side in de app zelf.
async function scrapeWeInvest() {
  const out = [];
  const url = 'https://weinvest.be/nl-BE/agencies/antwerpen-zuidrand/50';
  let html = '';
  let rawLinks = 0;
  try {
    const res = await timeoutFetch(url, 9000);
    if (!res.ok) return { items: out, diagnostics: [{ url, httpStatus: res.status }] };
    html = await res.text();
    const $ = cheerio.load(html);
    const matches = $('a[href*="/nl-BE/property/"]');
    rawLinks = matches.length;

    matches.each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const fullUrl = href.startsWith('http') ? href : `https://weinvest.be${href}`;
      const found = findPriceBlock($, el);
      if (!found) return;

      const kamersMatch = found.block.match(/(\d+)\s*(?:slaapkamer|kamer)/i);
      const oppMatch = found.block.match(/(\d+)\s*m²/);
      const adres = ($(el).text() || '').replace(/\s+/g, ' ').trim().slice(0, 80) || found.block.slice(0, 60);

      out.push({
        id: makeId('We Invest', fullUrl),
        adres: adres || 'Antwerpen Zuidrand',
        regio: 'Zuidrand (We Invest)',
        prijs: found.prijs,
        kamers: kamersMatch ? parseInt(kamersMatch[1], 10) : 0,
        tuin: /tuin/i.test(found.block),
        opp: oppMatch ? parseInt(oppMatch[1], 10) : 0,
        bron: 'We Invest',
        url: fullUrl,
        datum: todayISO(),
        score: 0,
        gezien: false,
        icon: '🏡',
        kleur: '#f5ede0',
      });
    });
    return { items: dedupeByUrl(out).slice(0, 40), diagnostics: [Object.assign({ url }, diag(html, rawLinks, out.length))] };
  } catch (e) {
    return { items: out, diagnostics: [{ url, error: String(e && e.message || e) }] };
  }
}

// ═══ DE HUISLEVERANCIER (Kontich, max-immo CMS) ═══
// UITGESCHAKELD: geeft een harde HTTP 403 terug op een server-side fetch —
// deze site blokkeert dit actief (waarschijnlijk op user-agent/referrer).
async function scrapeHuisleverancier() {
  return { items: [], diagnostics: [{ info: 'De Huisleverancier overgeslagen — blokkeert server-side aanvragen (HTTP 403).' }] };
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
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: String(err && err.message || err) }),
    };
  }
};
