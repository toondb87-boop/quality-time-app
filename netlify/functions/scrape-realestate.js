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

// ═══ IMMOWEB ═══
async function scrapeImmoweb(regios) {
  const out = [];
  for (const regio of regios) {
    const slug = IMMOWEB_SLUGS[regio];
    if (!slug) continue;
    const url = `https://www.immoweb.be/nl/zoeken/huis-en-appartement/te-koop/${slug}`;
    try {
      const res = await timeoutFetch(url, 9000);
      if (!res.ok) continue;
      const html = await res.text();
      const $ = cheerio.load(html);

      // Immoweb rendert kaarten met links naar /nl/pand/... — we lopen alle
      // <a> na die naar zo'n pand-URL wijzen en zoeken prijs/kamers/opp in
      // de omliggende tekst van het bloksgewijs dichtstbijzijnde element.
      $('a[href*="/nl/pand/"], a[href*="/classified/"]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        const fullUrl = href.startsWith('http') ? href : `https://www.immoweb.be${href}`;
        const block = $(el).closest('article, li, div').text().replace(/\s+/g, ' ').trim();
        if (!block || block.length < 10) return;

        const prijs = parsePrice(block);
        if (!prijs || prijs < 30000) return; // ruis wegfilteren

        const kamersMatch = block.match(/(\d+)\s*(?:slaapkamer|kamer)/i);
        const oppMatch = block.match(/(\d+)\s*m²/);
        const adres = ($(el).text() || '').replace(/\s+/g, ' ').trim().slice(0, 80) || block.slice(0, 60);

        out.push({
          id: makeId('Immoweb', fullUrl),
          adres: adres || regio,
          regio,
          prijs,
          kamers: kamersMatch ? parseInt(kamersMatch[1], 10) : 0,
          tuin: /tuin/i.test(block),
          opp: oppMatch ? parseInt(oppMatch[1], 10) : 0,
          bron: 'Immoweb',
          url: fullUrl,
          datum: todayISO(),
          score: 0,
          gezien: false,
          icon: '🏘️',
          kleur: '#f5ede0',
        });
      });
    } catch (e) {
      // stille fout per regio — andere regio's / bronnen gaan gewoon door
    }
  }
  return dedupeByUrl(out).slice(0, 40);
}

// ═══ ERA ═══
async function scrapeEra(regios) {
  const out = [];
  for (const regio of regios) {
    const slug = ERA_SLUGS[regio];
    if (!slug) continue;
    for (const type of ['huis', 'appartement']) {
      const url = `https://www.era.be/nl/te-koop/${slug}/${type}`;
      try {
        const res = await timeoutFetch(url, 9000);
        if (!res.ok) continue;
        const html = await res.text();
        const $ = cheerio.load(html);

        $('a[href*="/nl/pand/"], a[href*="/te-koop/"]').each((_, el) => {
          const href = $(el).attr('href');
          if (!href || !/\/pand\//.test(href)) return;
          const fullUrl = href.startsWith('http') ? href : `https://www.era.be${href}`;
          const block = $(el).closest('article, li, div').text().replace(/\s+/g, ' ').trim();
          if (!block || block.length < 10) return;

          const prijs = parsePrice(block);
          if (!prijs || prijs < 30000) return;

          const kamersMatch = block.match(/(\d+)\s*(?:slaapkamer|kamer)/i);
          const oppMatch = block.match(/(\d+)\s*m²/);
          const adres = ($(el).text() || '').replace(/\s+/g, ' ').trim().slice(0, 80) || block.slice(0, 60);

          out.push({
            id: makeId('ERA', fullUrl),
            adres: adres || regio,
            regio,
            prijs,
            kamers: kamersMatch ? parseInt(kamersMatch[1], 10) : 0,
            tuin: /tuin/i.test(block),
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
      } catch (e) {
        // volgende regio/type
      }
    }
  }
  return dedupeByUrl(out).slice(0, 40);
}

// ═══ WE INVEST ANTWERPEN ZUIDRAND ═══
// Dit kantoor dekt exact de Zuidrand-gemeenten, dus we halen gewoon hun hele
// "te koop"-aanbod op zonder per-regio te filteren op URL-niveau — het
// filteren op regio gebeurt client-side in de app zelf.
async function scrapeWeInvest() {
  const out = [];
  const url = 'https://weinvest.be/nl-BE/agencies/antwerpen-zuidrand/50';
  try {
    const res = await timeoutFetch(url, 9000);
    if (!res.ok) return out;
    const html = await res.text();
    const $ = cheerio.load(html);

    $('a[href*="/nl-BE/property/"]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const fullUrl = href.startsWith('http') ? href : `https://weinvest.be${href}`;
      const block = $(el).closest('article, li, div').text().replace(/\s+/g, ' ').trim();
      if (!block || block.length < 10) return;

      const prijs = parsePrice(block);
      if (!prijs || prijs < 30000) return;

      const kamersMatch = block.match(/(\d+)\s*(?:slaapkamer|kamer)/i);
      const oppMatch = block.match(/(\d+)\s*m²/);
      const adres = ($(el).text() || '').replace(/\s+/g, ' ').trim().slice(0, 80) || block.slice(0, 60);

      out.push({
        id: makeId('We Invest', fullUrl),
        adres: adres || 'Antwerpen Zuidrand',
        regio: 'Zuidrand (We Invest)',
        prijs,
        kamers: kamersMatch ? parseInt(kamersMatch[1], 10) : 0,
        tuin: /tuin/i.test(block),
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
  } catch (e) {
    // geeft gewoon lege lijst terug
  }
  return dedupeByUrl(out).slice(0, 40);
}

// ═══ DE HUISLEVERANCIER (Kontich, max-immo CMS) ═══
async function scrapeHuisleverancier() {
  const out = [];
  const url = 'https://www.dehuisleverancier.be/te-koop/map?_locale=nl';
  try {
    const res = await timeoutFetch(url, 9000);
    if (!res.ok) return out;
    const html = await res.text();
    const $ = cheerio.load(html);

    $('a[href*="/te-koop/"]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || href.endsWith('/te-koop/map')) return;
      const fullUrl = href.startsWith('http') ? href : `https://www.dehuisleverancier.be${href}`;
      const block = $(el).closest('article, li, div').text().replace(/\s+/g, ' ').trim();
      if (!block || block.length < 5) return;

      const prijs = parsePrice(block);
      if (!prijs || prijs < 30000) return;

      const kamersMatch = block.match(/(\d+)\s*(?:slaapkamer|kamer)/i);
      const oppMatch = block.match(/(\d+)\s*m²/);
      const adres = ($(el).text() || '').replace(/\s+/g, ' ').trim().slice(0, 80) || block.slice(0, 60);

      out.push({
        id: makeId('De Huisleverancier', fullUrl),
        adres: adres || 'Zuidrand',
        regio: 'Kontich e.o. (De Huisleverancier)',
        prijs,
        kamers: kamersMatch ? parseInt(kamersMatch[1], 10) : 0,
        tuin: /tuin/i.test(block),
        opp: oppMatch ? parseInt(oppMatch[1], 10) : 0,
        bron: 'De Huisleverancier',
        url: fullUrl,
        datum: todayISO(),
        score: 0,
        gezien: false,
        icon: '🏠',
        kleur: '#ece0d0',
      });
    });
  } catch (e) {
    // geeft gewoon lege lijst terug
  }
  return dedupeByUrl(out).slice(0, 40);
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

    results.forEach((r, i) => {
      const naam = bronnen[i];
      if (r.status === 'fulfilled') {
        listings.push(...r.value);
        status[naam] = { ok: true, count: r.value.length };
      } else {
        status[naam] = { ok: false, error: String(r.reason && r.reason.message || r.reason) };
      }
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        listings,
        status,
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
