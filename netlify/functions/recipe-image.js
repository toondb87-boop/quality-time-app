// netlify/functions/recipe-image.js
//
// Haalt een foto op voor een recept, in twee stappen:
//
//  1) Als er een specifieke bronlink is: probeer de og:image / twitter:image
//     van die pagina te lezen (de foto die de bron zelf bij dat recept
//     toont).
//
//  2) Lukt dat niet (geen link, of geen foto-tag gevonden), en is er een
//     Unsplash API-key geconfigureerd, zoek dan op Unsplash naar een foto
//     die bij de RECEPTNAAM past — dat geeft een foto die het gerecht
//     inhoudelijk representeert, in plaats van een willekeurige generieke
//     stockfoto per brede categorie.
//
// Faalt alles (of is er geen Unsplash-key ingesteld), dan geeft deze functie
// { image: null } terug — de app valt dan client-side terug op de bestaande
// generieke Foodish-foto, dus er is altijd een nette fallback.
//
// ── Unsplash API-key instellen ──
// 1. Maak gratis een account op https://unsplash.com/developers
// 2. Maak een nieuwe "app" aan, kopieer de "Access Key"
// 3. Zet die in Netlify: Site settings → Environment variables →
//    voeg toe: UNSPLASH_ACCESS_KEY = <jouw access key>
// 4. Herdeploy de site zodat de nieuwe env var meegenomen wordt.
// Zonder deze key werkt stap 2 hierboven gewoon niet (blijft altijd null),
// maar de rest van de app (inclusief stap 1) blijft gewoon werken.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const FETCH_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'nl-BE,nl;q=0.9,en;q=0.8',
};

function timeoutFetch(url, ms, extraHeaders) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return fetch(url, { headers: Object.assign({}, FETCH_HEADERS, extraHeaders || {}), signal: controller.signal })
    .finally(() => clearTimeout(t));
}

function extractImage(html, baseUrl) {
  const metaPatterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
  ];
  for (const re of metaPatterns) {
    const m = html.match(re);
    if (m && m[1]) return resolveUrl(m[1], baseUrl);
  }
  return null;
}

function resolveUrl(maybeRelative, baseUrl) {
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch (e) {
    return null;
  }
}

async function tryOgImage(url) {
  if (!url) return null;
  try {
    const res = await timeoutFetch(url, 8000);
    if (!res.ok) return null;
    const html = await res.text();
    return extractImage(html, url);
  } catch (e) {
    return null;
  }
}

async function tryUnsplashSearch(query) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key || !query) return null;
  try {
    const searchUrl = 'https://api.unsplash.com/search/photos?per_page=1&orientation=landscape&query='
      + encodeURIComponent(query + ' food dish recipe');
    const res = await timeoutFetch(searchUrl, 7000, { Authorization: 'Client-ID ' + key });
    if (!res.ok) return null;
    const data = await res.json();
    const first = data && data.results && data.results[0];
    if (!first || !first.urls) return null;
    return first.urls.regular || first.urls.small || null;
  } catch (e) {
    return null;
  }
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=86400',
  };

  try {
    const qs = event.queryStringParameters || {};
    const url = qs.url;
    const query = qs.query;

    if (!url && !query) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Geef minstens url of query mee', image: null }) };
    }

    // Stap 1: og:image van de bron
    let image = null;
    let source = 'none';
    if (url && /^https?:\/\//i.test(url)) {
      image = await tryOgImage(url);
      if (image) source = 'og:image';
    }

    // Stap 2: Unsplash-zoekresultaat op basis van de receptnaam
    if (!image && query) {
      image = await tryUnsplashSearch(query);
      if (image) source = 'unsplash';
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ image, source }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: String(err && err.message || err), image: null }),
    };
  }
};
