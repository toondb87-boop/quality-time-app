// netlify/functions/recipe-image.js
//
// Haalt de "echte" foto van een recept op bij de bron waar het vandaan komt
// (bv. dagelijksekost.een.be, ottolenghi.co.uk, njam.tv, seriouseats.com),
// door de og:image / twitter:image meta-tag van die pagina uit te lezen.
// Zo tonen we de foto die de bron zelf bij dat recept gebruikt, in plaats
// van een willekeurige generieke voorbeeldfoto.
//
// Faalt de bron (blokkeert, geen og:image, timeout, ...), dan geeft deze
// functie gewoon { image: null } terug — de app valt dan client-side terug
// op de bestaande generieke foto, dus er is altijd een nette fallback.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const FETCH_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'nl-BE,nl;q=0.9,en;q=0.8',
};

function timeoutFetch(url, ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return fetch(url, { headers: FETCH_HEADERS, signal: controller.signal })
    .finally(() => clearTimeout(t));
}

// Zoekt og:image / twitter:image / eerste grote <img> als laatste redmiddel,
// zonder een zware HTML-parser nodig te hebben (regex volstaat voor meta-tags).
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

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=86400', // 1 dag cachen, recept-foto's veranderen niet
  };

  try {
    const qs = event.queryStringParameters || {};
    const url = qs.url;

    if (!url || !/^https?:\/\//i.test(url)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ongeldige of ontbrekende url', image: null }) };
    }

    let html;
    try {
      const res = await timeoutFetch(url, 8000);
      if (!res.ok) {
        return { statusCode: 200, headers, body: JSON.stringify({ image: null, reason: 'HTTP ' + res.status }) };
      }
      html = await res.text();
    } catch (e) {
      return { statusCode: 200, headers, body: JSON.stringify({ image: null, reason: String(e && e.message || e) }) };
    }

    const image = extractImage(html, url);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ image, source: url }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: String(err && err.message || err), image: null }),
    };
  }
};
