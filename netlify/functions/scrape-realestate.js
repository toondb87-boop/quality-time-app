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

// Immoscoop gebruikt postcode-gemeente-slugs, bv. "2140-borgerhout"
const IMMOSCOOP_SLUGS = {
  'Borgerhout': '2140-borgerhout',
  'Mortsel': '2640-mortsel',
  'Edegem': '2650-edegem',
  'Hove': '2540-hove',
  'Boechout': '2530-boechout',
  'Berchem': '2600-berchem',
  '2018 Antwerpen': '2018-antwerpen',
  'Kontich': '2550-kontich',
  'Aartselaar': '2630-aartselaar',
  'Wilrijk': '2610-wilrijk',
  'Lint': '2547-lint',
};

// Links die duidelijk GEEN pand-detailpagina zijn — komen ook terug in de
// listing-omgeving maar mogen nooit als "pand" beschouwd worden.
const IMMOSCOOP_NAV_PATTERNS = [
  '/zoeken/', '/content/', '/help/', '/juridische-info', '/simulatie',
  '/gratis-schatting', '/private-ads', '/100-procent-lenen', '/straten/',
  'apps.apple.com', 'play.google.com', 'mailto:', '/en/search/',
];

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

// Immoscoop's kaarttekst is één aaneengeplakte string zonder spaties tussen
// straat/postcode/gemeente (bv. "Te Boelaarlei 682140 Borgerhout"). Straat-
// nummer en postcode vloeien dus letterlijk in elkaar over. We zoeken het
// kortste getal vóór een geldige 4-cijferige postcode + gemeentenaam.
function extractImmoscoopAddress(block) {
  const m = block.match(/([A-ZÀ-Ý][A-Za-zÀ-ÿ.'\s-]*?\d+?[a-zA-Z]?)(\d{4})\s?([A-ZÀ-Ý][a-zà-ÿ]+)/i);
  if (!m) return null;
  const straat = m[1].trim();
  if (straat.length < 4) return null;
  return `${straat}, ${m[2]} ${m[3]}`;
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

// ═══ IMMOWEB ═══
// UITGESCHAKELD, definitief: vereist een headless browser (Chromium), en
// Netlify's servers missen een systeembibliotheek (libnspr4.so) die Chromium
// nodig heeft om te starten. Dit is een omgevingsbeperking van het gratis
// Netlify-platform, niet iets wat via code of packages op te lossen is.
async function scrapeImmoweb(regios) {
  return { items: [], diagnostics: [{ info: 'Immoweb overgeslagen — vereist een headless browser, en Netlify mist de systeembibliotheken (libnspr4.so) die Chromium nodig heeft. Definitieve omgevingsbeperking.' }] };
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

// ═══ IMMOSCOOP — koepelplatform van lokale makelaars, gewone fetch (server-side gerenderd) ═══
async function scrapeImmoscoop(regios) {
  const out = [];
  const diagnostics = [];
  for (const regio of regios) {
    const slug = IMMOSCOOP_SLUGS[regio];
    if (!slug) continue;
    const url = `https://www.immoscoop.be/zoeken/te-koop/${slug}`;
    let html = '';
    let rawLinks = 0;
    try {
      const res = await timeoutFetch(url, 9000);
      if (!res.ok) { diagnostics.push({ regio, url, httpStatus: res.status }); continue; }
      html = await res.text();
      const $ = cheerio.load(html);
      const matches = $('a[href]').filter((_, el) => {
        const href = $(el).attr('href') || '';
        if (!href.startsWith('/') && !href.startsWith('https://www.immoscoop.be/')) return false;
        return !IMMOSCOOP_NAV_PATTERNS.some(p => href.includes(p));
      });
      rawLinks = matches.length;
      let kept = 0;

      matches.each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        const fullUrl = href.startsWith('http') ? href : `https://www.immoscoop.be${href}`;
        const found = findPriceBlock($, el);
        if (!found) return;
        const extra = extractFromBlock(found.block);
        const adres = extractImmoscoopAddress(found.block) || titleFromSlug(fullUrl) || regio;

        out.push({
          id: makeId('Immoscoop', fullUrl),
          adres: adres || regio,
          regio,
          prijs: found.prijs,
          kamers: extra.kamers,
          tuin: extra.tuin,
          opp: extra.opp,
          bron: 'Immoscoop',
          url: fullUrl,
          datum: todayISO(),
          score: 0,
          gezien: false,
          icon: '🔎',
          kleur: '#e2fbfb',
        });
        kept++;
      });
      diagnostics.push(Object.assign({ regio, url }, diag(html, rawLinks, kept)));
    } catch (e) {
      diagnostics.push({ regio, url, error: String(e && e.message || e) });
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
    const samples = [];

    matches.each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const fullUrl = href.startsWith('http') ? href : `https://weinvest.be${href}`;
      const found = findPriceBlock($, el);
      if (!found) {
        if (samples.length < 3) {
          samples.push({ href: fullUrl, topAncestorText: $(el).parent().parent().parent().parent().parent().text().replace(/\s+/g, ' ').trim().slice(0, 300) });
        }
        return;
      }
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
    return { items: dedupeByUrl(out).slice(0, 40), diagnostics: [Object.assign({ url, samples }, diag(html, matches.length, kept))] };
  } catch (e) {
    return { items: out, diagnostics: [{ url, error: String(e && e.message || e) }] };
  }
}

// ═══ DE HUISLEVERANCIER ═══
// UITGESCHAKELD, definitief: gaf al een harde HTTP 403 op een gewone fetch,
// en de headless-browser-poging faalde op dezelfde ontbrekende systeem-
// bibliotheken als Immoweb (zie hierboven) — zelfde omgevingsbeperking.
async function scrapeHuisleverancier() {
  return { items: [], diagnostics: [{ info: 'De Huisleverancier overgeslagen — blokkeert server-side aanvragen (HTTP 403) en headless-browser lukt niet door dezelfde Netlify-omgevingsbeperking als Immoweb.' }] };
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
      scrapeImmoscoop(effectiveRegios),
    ]);


    const bronnen = ['Immoweb', 'ERA', 'We Invest', 'De Huisleverancier', 'Immoscoop'];
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
