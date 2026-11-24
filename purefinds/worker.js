// PureFinds store scanner, a Cloudflare Worker (works on the free plan).
// Paste this whole file into a Worker named "purefinds" and press Deploy.
//
//   /stores                     the store list
//   /store?d=kotn.com&type=cotton   one store's clothing that is 100% cotton, silk, wool or linen (never mixed)
//   /store?d=lesserevil.com&type=food   one store's food (the site applies the food rules)
//   /details?url=<product page>  ingredients (or fabric) read from the product's own page,
//                                with Open Food Facts as a backup when the page doesn't list them
//
//   /etsy?q=100%25+silk+dress   100% cotton, silk, wool or linen clothing listings from Etsy (needs the ETSY_KEY secret)
//
// Optional: add a secret named ETSY_KEY with your Etsy keystring and shared secret joined by a colon
// (keystring:sharedsecret) to turn on Etsy.
// Optional: add a secret named FDC_KEY (free key from fdc.nal.usda.gov/api-key-signup)
// and the scanner also checks USDA FoodData Central for missing ingredient lists.

const VERSION = '1.6.6';

// Add or remove stores here. Each must be a Shopify store (most brand websites are).
const STORES = {
  cotton: [
    ['kotn.com', 'Kotn'], ['christydawn.com', 'Christy Dawn'], ['matethelabel.com', 'MATE the Label'],
    ['ladywhiteco.com', 'Lady White Co.'], ['cottonique.com', 'Cottonique'], ['losangelesapparel.net', 'Los Angeles Apparel'],
    ['www.jennikayne.com', 'Jenni Kayne'], ['shopdoen.com', 'DÔEN'], ['www.hillhousehome.com', 'Hill House Home'],
    ['printfresh.com', 'Printfresh'], ['sleepyjones.com', 'Sleepy Jones'], ['colorfulstandard.com', 'Colorful Standard'],
    ['harvestandmill.com', 'Harvest & Mill'], ['theclassictshirt.com', 'The Classic T-Shirt Company'],
    ['organicbasics.com', 'Organic Basics'], ['merzbschwanen.com', 'Merz b. Schwanen'], ['babaa.es', 'Babaà'],
    ['tradlands.com', 'Tradlands'], ['outerknown.com', 'Outerknown'],
    ['www.kowtowclothing.com', 'Kowtow'], ['lucyandyak.com', 'Lucy & Yak'], ['www.loveshackfancy.com', 'LoveShackFancy'],
    ['knownsupply.com', 'Known Supply']
  ],
  food: [
    ['yumearth.com', 'YumEarth'], ['www.theochocolate.com', 'Theo Chocolate'], ['lesserevil.com', 'LesserEvil'],
    ['mavunoharvest.com', 'Mavuno Harvest'], ['www.marysgonecrackers.com', "Mary's Gone Crackers"],
    ['purelyelizabeth.com', 'Purely Elizabeth'], ['onceuponafarmorganics.com', 'Once Upon a Farm'],
    ['www.alterecofoods.com', 'Alter Eco'], ['madegoodfoods.com', 'Made Good'], ['hukitchen.com', 'Hu Kitchen'],
    ['janiesmill.com', "Janie's Mill"], ['jovialfoods.com', 'Jovial'], ['yolele.com', 'Yolélé'],
    ['wildernesspoets.com', 'Wilderness Poets'], ['www.navitasorganics.com', 'Navitas Organics'],
    ['www.terrasoul.com', 'Terrasoul Superfoods'], ['barnana.com', 'Barnana'], ['anthonysgoods.com', "Anthony's Goods"],
    ['www.sunfood.com', 'Sunfood'], ['www.larkellenfarm.com', 'Lark Ellen Farm'], ['elmhurst1925.com', 'Elmhurst 1925'],
    ['www.paleonola.com', 'Paleonola'], ['sevensundays.com', 'Seven Sundays'], ['www.seaveg.com', 'Maine Coast Sea Vegetables'], ['dailycrunchsnacks.com', 'Daily Crunch']
    // Removed: To Your Health Sprouted Flour, Shiloh Farms, One Degree and Bob's Red Mill.
    // Their websites don't publish a product list the scanner can read.
  ]
};
const ALLOWED = new Map();
for (const [domain, name] of [...STORES.cotton, ...STORES.food]) ALLOWED.set(domain, name);

const CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'};
const json = (o, status = 200, maxAge = 1800) => new Response(JSON.stringify(o), {
  status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${maxAge}`, ...CORS}
});
const UA = {'User-Agent': 'PureFinds/1.0 (personal shopping finder)', 'Accept': 'application/json,text/html'};
// Product pages come back as a stripped-down shell (2 to 10 KB) when the visitor looks like a bot, so page reads use an ordinary browser's headers
const PAGE_UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9'};

export default {
  async fetch(req, env){
    if (req.method === 'OPTIONS') return new Response(null, {headers: CORS});
    const u = new URL(req.url);
    try {
      if (u.pathname === '/' || u.pathname === '/stores') return json({version: VERSION, stores: STORES}, 200, 300);
      if (u.pathname === '/store'){
        const d = (u.searchParams.get('d') || '').toLowerCase(), type = u.searchParams.get('type');
        if (!ALLOWED.has(d)) return json({error: 'This store is not on the PureFinds list: ' + d}, 400);
        if (type !== 'cotton' && type !== 'food') return json({error: 'type must be cotton or food'}, 400);
        const items = await scan(d, type);
        return json({store: ALLOWED.get(d), domain: d, type, count: items.length, checked: new Date().toISOString(), items}, 200, 21600);
      }
      if (u.pathname === '/off'){ // lets the site reach Open Food Facts through this worker when the visitor's browser cannot
        const target = new URL(u.searchParams.get('u') || '');
        if (target.protocol !== 'https:' || !/^(world|search)\.openfoodfacts\.org$/.test(target.hostname)) return json({error: 'Only Open Food Facts search addresses can be fetched.'}, 400);
        const r = await fetch(target.toString(), {headers: UA, cf: {cacheTtl: 3600, cacheEverything: true}});
        if (!r.ok) return json({error: `Open Food Facts answered HTTP ${r.status}`}, 502, 0);
        return json(await r.json(), 200, 3600);
      }
      if (u.pathname === '/etsy'){
        const q = (u.searchParams.get('q') || '').slice(0, 80).trim();
        if (!q) return json({error: 'Add a search, for example /etsy?q=100% cotton dress'}, 400);
        if (!env.ETSY_KEY) return json({error: 'Etsy is not set up yet: add a Worker secret named ETSY_KEY (keystring:sharedsecret).'}, 501, 0);
        return json({items: await etsySearch(q, env.ETSY_KEY)}, 200, 21600);
      }
      if (u.pathname === '/details'){
        const target = new URL(u.searchParams.get('url') || '');
        if (!ALLOWED.has(target.hostname) || target.protocol !== 'https:') return json({error: 'Only product pages from PureFinds stores can be read.'}, 400);
        return json(await details(target, env), 200, 86400);
      }
      return json({error: 'Not found'}, 404);
    } catch (e){
      return json({error: String((e && e.message) || e)}, 502, 0);
    }
  }
};

/* ---------- helpers ---------- */
const plain = h => String(h || '')
  .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '. ')
  .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&(#39|rsquo|lsquo);/g, "'").replace(/&(quot|ldquo|rdquo);/g, '"')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&[a-z]+;/g, ' ')
  .replace(/\s+/g, ' ').trim();
// Same as plain(), but list items are joined with commas, so an ingredient list built as <li> items still reads as "a, b, c"
const plainList = h => plain(String(h || '').replace(/<\/li>/gi, ', ').replace(/<li\b[^>]*>/gi, ' '));
const optionValues = (p, re) => ((p.options || []).find(o => re.test(o.name)) || {}).values || [];
const available = p => (p.variants || []).some(v => v.available !== false);
const minPrice = p => { const ps = (p.variants || []).map(v => +v.price).filter(n => n > 0); return ps.length ? Math.min(...ps) : null; };

async function getJSON(url){
  const r = await fetch(url, {headers: UA, cf: {cacheTtl: 21600, cacheEverything: true}});
  if (!r.ok) throw new Error(`${new URL(url).hostname} answered HTTP ${r.status}`);
  if (!(r.headers.get('content-type') || '').includes('json')) throw new Error(`${new URL(url).hostname} did not send product data (it may not be a Shopify store)`);
  return r.json();
}

// Shopify stores first, then WooCommerce (WordPress) stores, which publish a public product list too
async function scan(d, type){
  const keep = ps => ps.map(p => type === 'cotton' ? cottonItem(d, p) : foodItem(d, p)).filter(Boolean);
  let shopifyErr;
  try {
    const out = [];
    for (let page = 1; page <= 4; page++){
      const ps = (await getJSON(`https://${d}/products.json?limit=250&page=${page}`)).products || [];
      out.push(...keep(ps));
      if (ps.length < 250) break;
    }
    return out;
  } catch (e){ shopifyErr = String(e.message || e); }
  try {
    const out = [];
    for (let page = 1; page <= 4; page++){
      const ps = await getJSON(`https://${d}/wp-json/wc/store/v1/products?per_page=100&page=${page}`);
      if (!Array.isArray(ps)) throw new Error('unexpected reply');
      out.push(...keep(ps.map(fromWoo)));
      if (ps.length < 100) break;
    }
    return out;
  } catch (e){
    throw new Error(`${d} isn't readable as a Shopify or WooCommerce store, or it blocks the scanner. Shopify: ${shopifyErr}. WooCommerce: ${String(e.message || e)}.`);
  }
}
function fromWoo(x){
  const minor = (x.prices && x.prices.currency_minor_unit) || 2, link = x.permalink || '';
  return {
    title: plain(x.name), handle: (new URL(link || 'https://x/p').pathname.split('/').filter(Boolean).pop() || String(x.id)), _url: link,
    product_type: (x.categories || []).map(c => c.name).join(' '), tags: [...(x.categories || []), ...(x.tags || [])].map(t => t.name),
    body_html: `${x.description || ''} ${x.short_description || ''}`,
    variants: [{price: x.prices ? +x.prices.price / 10 ** minor : 0, available: x.is_in_stock !== false, barcode: x.sku && /^\d{8,14}$/.test(x.sku) ? x.sku : ''}],
    options: (x.attributes || []).map(a => ({name: a.name, values: (a.terms || []).map(t => t.name)})),
    images: (x.images || []).map(i => ({src: i.src})), published_at: ''
  };
}

const base = (d, p) => ({
  domain: d, store: ALLOWED.get(d), vendor: p.vendor || ALLOWED.get(d), handle: p.handle, name: p.title,
  url: p._url || `https://${d}/products/${p.handle}`, img: ((p.images || [])[0] || {}).src || '', price: minPrice(p),
  ptype: p.product_type || '', tags: Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',').map(t => t.trim()),
  created: p.published_at || p.created_at || ''
});

/* ---------- clothing that is 100% cotton, silk, wool or linen (one fabric, never mixed) ---------- */
const CLOTHING = /\b(dress|top|tee|t-shirt|shirt|blouse|tank|cami|sweater|cardigan|hoodie|sweatshirt|crewneck|pullover|pant|trouser|jogger|sweatpant|jean|short|skirt|pajama|pj|sleep|robe|nightgown|sock|underwear|brief|boxer|bra|bralette|legging|jacket|coat|overall|jumpsuit|romper|polo|henley|turtleneck|lounge|thong|bikini|hipster|longsleeve|knit|slip|camisole|scrunchie|pillowcase)s?\b/i;
const NOT_CLOTHING = /\b(sheet|duvet|pillow|towel|blanket|quilt|napkin|tablecloth|bag|tote|gift ?card|candle|mug|scarf|beanie|hat|cap|arm sleeve|headband|mask)s?\b/i;
const FABRIC_LINE = /[^.;!?]{0,60}100\s*%\s*(?:(?:certified|gots[- ]certified|organic|egyptian|pima|supima|combed|ring[- ]spun|japanese|japan|turkish|peruvian|regenerative(?:ly grown)?|us[- ]grown|american[- ]grown|heavyweight|brushed|pure|mulberry|charmeuse|merino|lambs|lamb's|virgin|superfine|extra[- ]fine|european|french|belgian|irish|italian|stonewashed|washed|natural|new zealand|australian)\s+){0,3}(cotton|silk|(?:lambs)?wool|linen)\b[^.;!?]{0,50}/i;
const FIBERS = {
  cotton: 'cotton', silk: 'silk', wool: 'wool|woolen|woollen|lambswool|merino', linen: 'linen|flax'
};
const OTHER_FIBERS = 'polyester|spandex|elastane|lycra|nylon|acrylic|rayon|viscose|lyocell|tencel|modal|cupro|cashmere|alpaca|mohair|angora|camel hair|hemp|bamboo|ramie|jute|lurex|metallic|polyamide|elasterell|polyurethane|faux fur|leather|down fill';
// Returns the fabric line and name ("Cotton", "Silk", "Wool" or "Linen") only when the text says 100% of one of them and mentions no other fiber at all
function pureFabric(text){
  const m = String(text || '').match(FABRIC_LINE); if (!m) return null;
  const name = m[1].toLowerCase().replace('lambswool', 'wool'), others = Object.entries(FIBERS).filter(([k]) => k !== name).map(([, v]) => v).join('|');
  if (new RegExp('\\b(' + OTHER_FIBERS + '|' + others + ')\\b', 'i').test(text)) return null;
  return {line: m[0].trim(), material: name[0].toUpperCase() + name.slice(1)};
}
function cottonItem(d, p){
  const title = p.title || '', kind = `${p.product_type || ''} ${title}`;
  if (!CLOTHING.test(kind) || NOT_CLOTHING.test(kind) || !available(p)) return null;
  const f = pureFabric(plain(p.body_html)); if (!f) return null;
  return {...base(d, p), fabric: f.line, material: f.material, sizes: optionValues(p, /size/i), colors: optionValues(p, /colou?r/i)};
}

/* ---------- Etsy (clothing that is 100% cotton, silk, wool or linen) ---------- */
async function etsySearch(q, key){
  const url = 'https://openapi.etsy.com/v3/application/listings/active?' + new URLSearchParams({keywords: q, limit: '100', sort_on: 'score', includes: 'Images,Shop'});
  const r = await fetch(url, {headers: {...UA, 'x-api-key': key}, cf: {cacheTtl: 21600, cacheEverything: true}});
  if (!r.ok){ let why = ''; try { why = ': ' + (await r.json()).error; } catch (e){} throw new Error(`Etsy answered HTTP ${r.status}${why}`); }
  const out = [];
  for (const l of (await r.json()).results || []){
    const text = plain(`${l.title} ${l.description}`), kind = `${l.title} ${(l.tags || []).join(' ')} ${(l.taxonomy_path || []).join(' ')}`;
    const f = pureFabric(plain(l.description)) || pureFabric(plain(l.title));
    if (!f || OTHER_FIBERS && new RegExp('\\b(' + OTHER_FIBERS + ')\\b', 'i').test(text) || !CLOTHING.test(kind) || NOT_CLOTHING.test(l.title || '') || (l.state && l.state !== 'active')) continue;
    const price = l.price && l.price.divisor ? l.price.amount / l.price.divisor : null;
    out.push({
      domain: 'etsy.com', store: 'Etsy', vendor: (l.shop && l.shop.shop_name) || 'Etsy seller', handle: String(l.listing_id), name: plain(l.title),
      url: String(l.url || `https://www.etsy.com/listing/${l.listing_id}`).split('?')[0], img: ((l.images || [])[0] || {}).url_570xN || '', price,
      ptype: (l.taxonomy_path || []).join(' '), tags: l.tags || [], created: l.creation_timestamp ? new Date(l.creation_timestamp * 1000).toISOString() : '',
      fabric: f.line, material: f.material, sizes: [], colors: []
    });
  }
  return out;
}

/* ---------- organic or Non-GMO food ---------- */
const NOT_FOOD = /gift ?card|bundle|sampler|merch|tote|t-shirt|sweatshirt|\bhat\b|\bmug\b|apron|subscription box|e-?gift/i;
const NOT_FOOD_THING = /\b(baking\s+scale|kitchen\s+scale|scales?|pans?|sheet\s+pan|baking\s+(sheet|stone|mat|dish|tray)|trays?|molds?|moulds?|(cake|muffin|baking|loaf|pie)\s+tins?|ramekins?|whisks?|spatulas?|rolling\s+pins?|spoons?|ladles?|tongs|knives|knife|cutting\s+boards?|boards?|bowls?|mugs?|cups?\s+set|measuring\s+(cups?|spoons?)|thermometers?|timers?|bannetons?|proofing\s+baskets?|baskets?|lames?|scrapers?|sifters?|strainers?|colanders?|graters?|peelers?|grinders?|grain\s+mills?|blenders?|mixers?|machines?|appliances?|kettles?|teapots?|infusers?|tumblers?|water\s+bottles?|jars?\s+(set|only)|storage\s+(canisters?|containers?)|towels?|cloths?|aprons?|oven\s+mitts?|pot\s+holders?|cookbooks?|books?|recipe\s+cards?|posters?|prints?|stickers?|magnets?|candles?|ornaments?|gift\s+cards?|e-?gift|totes?|bags?\s+(reusable|canvas|cotton)|t-?shirts?|hoodies?|hats?|socks|merch|subscriptions?|memberships?|classes?|workshops?|vouchers?)\b/i; // kitchen tools, books and merch sold next to the food
const ING_STOP = /\s(?:contains|allergen|allergy|nutrition facts|directions|how to use|storage|store in|net wt|suggested use|manufactured|produced in|made in a facility|may contain|frequently asked|reviews|you may also|add to cart|shipping|distributed by|product testing|find in store|where to buy|customer reviews|write a review|add to bag|free shipping|you might also like|related products|nutrition|how to|faq)\b/i;
// Real ingredient lists are plain words and commas, never page code or store data
const looksLikeIngredients = t => {
  t = String(t || '').trim();
  if (!t || /[{}\[\]"<>=_\\|]|https?:|\b(sku|variant|price|product_id|compare_at|handle|json|null|true|false)\b/i.test(t) || t.split(/\s+/).length > 160) return false;
  // marketing sentences are not ingredient lists ("each selected for maximum deliciousness")
  if (/\b(delicious\w*|selected|crafted|enjoy\w*|perfect\w*|our|we|you\w*|maximum|favorite|love\w*|each)\b/i.test(t)) return false;
  const parts = t.split(/[,;]/).map(x => x.trim()).filter(Boolean);
  return parts.length >= 2 || (parts.length === 1 && t.split(/\s+/).length <= 8 && !/\.\s*$/.test(t));
};
const NAV_WORD = /\b(shop|cart|login|log in|sign in|account|search|menu|subscribe|contact|about us|our story|blog|careers|press|privacy|terms|shipping|returns|wholesale|store locator|recipes)\b/i;
function findIngredients(text){
  // The heading is often "Ingredients:", but accordions show just "Ingredients" followed by + or −, with no colon at all.
  // "Simple Ingredients" and "Full Ingredients" headings work the same way.
  const re = /\bingredients?\b[\s:\-–—+−×▼▲>|]*/gi; let m;
  const tidy = s => s.replace(/^[\s,.:;+−\-–]+|[\s,.:;+−\-–]+$/g, '').replace(/\s*,\s*(,\s*)+/g, ', ').replace(/\s+/g, ' ');
  const good = rest => {
    const parts = rest.split(/,/).map(x => x.trim()).filter(Boolean);
    return rest.length > 2 && looksLikeIngredients(rest) && !NAV_WORD.test(rest) && parts.length <= 70 && parts.every(x => x.split(' ').length <= 14)
      && (rest.includes(',') || /organic/i.test(rest) || rest.split(' ').length <= 6);
  };
  while ((m = re.exec(text))){
    let rest = text.slice(m.index + m[0].length, m.index + m[0].length + 1200);
    const stop = rest.search(ING_STOP); if (stop > 0) rest = rest.slice(0, stop);
    rest = tidy(rest);
    if (rest.length > 6 && good(rest)) return rest.slice(0, 900);
    // The list often runs straight into the next part of the page. Try it as one sentence, then two, so the page text after it is dropped.
    const sents = rest.split(/(?<=[.!?])\s+/).map(s => tidy(s)).filter(Boolean);
    for (const n of [1, 2]){
      const cand = tidy(sents.slice(0, n).join('. '));
      if (cand.length > 2 && good(cand)) return cand.slice(0, 900);
    }
  }
  return '';
}
function foodItem(d, p){
  const title = p.title || '';
  if (NOT_FOOD.test(`${title} ${p.product_type || ''}`) || NOT_FOOD_THING.test(`${title} ${p.product_type || ''}`) || !available(p)) return null;
  const text = plain(p.body_html), b = base(d, p), all = `${title} ${text} ${b.tags.join(' ')}`, listText = plainList(p.body_html);
  const organic = /usda[- ]organic/i.test(all) ? 'USDA Organic' : /certified organic/i.test(all) ? 'Certified organic' : /\borganic\b/i.test(all) ? 'Organic (brand wording)' : '';
  const nonGmo = /non[- ]?gmo project/i.test(all) ? 'Non-GMO Project Verified' : /non[- ]?gmo/i.test(all) ? 'Non-GMO (brand claim)' : '';
  return {...b, organic, nonGmo, ing: findIngredients(listText), desc: text.slice(0, 400), barcode: barcodeOf(p)};
}
function barcodeOf(p){
  const v = (p.variants || []).find(v => /^\d{8,14}$/.test(String(v.barcode || '')));
  if (v) return String(v.barcode);
  for (const im of p.images || []){ const m = String(im.src || '').match(/(?:^|[^\d])(\d{12,13})(?:[^\d]|$)/); if (m) return m[1]; }
  return '';
}

/* ---------- details for one product (opened when a listing is tapped) ---------- */
async function details(target, env){
  const d = target.hostname, handle = target.pathname.startsWith('/products/') ? target.pathname.split('/')[2] : '';
  const out = {url: target.href, ingredients: '', ingredientsSource: '', fabric: '', barcode: '', tried: []};
  // 1. the product's data file (Shopify stores)
  if (handle) try {
    const p = (await getJSON(`https://${d}/products/${handle}.json`)).product || {};
    const text = plain(p.body_html);
    out.ingredients = findIngredients(plainList(p.body_html)); out.fabric = ((pureFabric(text) || {}).line) || ''; out.barcode = barcodeOf(p);
    if (out.ingredients) out.ingredientsSource = 'Product description';
  } catch (e){ out.tried.push(String(e.message || e)); }
  // 2. the product page itself (ingredients are often in a tab or accordion)
  if (!out.ingredients){
    try {
      const r = await fetch(target.href, {headers: PAGE_UA, cf: {cacheTtl: 86400, cacheEverything: true, cacheKey: target.href + '#page2'}});
      if (!r.ok) throw new Error(`${d} page answered HTTP ${r.status}`);
      const html = await r.text(), text = plain(html);
      out.ingredients = findIngredients(plainList(html));
      if (out.ingredients) out.ingredientsSource = 'Product page';
      // what the page held, so a missing list can be diagnosed from the Debug page
      out.page = {status: r.status, length: html.length, mentions: (text.match(/ingredients?/gi) || []).length, snippets: (text.match(/.{0,30}\bingredients?\b.{0,150}/gi) || []).slice(0, 3)};
      if (!out.fabric) out.fabric = ((pureFabric(text) || {}).line) || '';
      if (!out.barcode){ const m = html.match(/"(?:gtin1[234]|gtin|barcode)"\s*:\s*"(\d{8,14})"/); if (m) out.barcode = m[1]; }
    } catch (e){ out.tried.push(String(e.message || e)); }
  }
  // 3. Open Food Facts by barcode
  if (!out.ingredients && out.barcode){
    try {
      const j = await getJSON(`https://world.openfoodfacts.org/api/v2/product/${out.barcode}.json?fields=ingredients_text_en,ingredients_text`);
      const t = (j.product && (j.product.ingredients_text_en || j.product.ingredients_text)) || '';
      if (t && looksLikeIngredients(t)){ out.ingredients = t.trim(); out.ingredientsSource = 'Open Food Facts (barcode ' + out.barcode + ')'; }
    } catch (e){ out.tried.push(String(e.message || e)); }
  }
  // 4. USDA FoodData Central by barcode (only if you added an FDC_KEY secret)
  if (!out.ingredients && out.barcode && env && env.FDC_KEY){
    try {
      const j = await getJSON(`https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${env.FDC_KEY}&dataType=Branded&query=${out.barcode}`);
      const f = (j.foods || []).find(f => String(f.gtinUpc || '').replace(/^0+/, '') === out.barcode.replace(/^0+/, '')) || (j.foods || [])[0];
      if (f && f.ingredients){ out.ingredients = f.ingredients.trim(); out.ingredientsSource = 'USDA FoodData Central (barcode ' + out.barcode + ')'; }
    } catch (e){ out.tried.push(String(e.message || e)); }
  }
  return out;
}
