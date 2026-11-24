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

const VERSION = '1.9.1';

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
    ['www.traditionalmedicinals.com', 'Traditional Medicinals'], ['wildernesspoets.com', 'Wilderness Poets'], ['www.navitasorganics.com', 'Navitas Organics'],
    ['www.terrasoul.com', 'Terrasoul Superfoods'], ['barnana.com', 'Barnana'], ['anthonysgoods.com', "Anthony's Goods"],
    ['www.sunfood.com', 'Sunfood'], ['www.larkellenfarm.com', 'Lark Ellen Farm'], ['elmhurst1925.com', 'Elmhurst 1925'],
    ['www.paleonola.com', 'Paleonola'], ['sevensundays.com', 'Seven Sundays'], ['www.seaveg.com', 'Maine Coast Sea Vegetables'], ['dailycrunchsnacks.com', 'Daily Crunch']
    // Removed: To Your Health Sprouted Flour, Shiloh Farms, One Degree and Bob's Red Mill.
    // Their websites don't publish a product list the scanner can read.
  ]
};
// Beauty Closet: skin, face, nail and hair care. Each is a Shopify store (checked); ingredient lists are read from the product pages.
STORES.beauty = [['carolsdaughter.com', "Carol's Daughter"], ['anua.com', 'ANUA'], ['herbivorebotanicals.com', 'Herbivore'], ['www.100percentpure.com', '100% Pure']];
const ALLOWED = new Map();
for (const [domain, name] of [...STORES.cotton, ...STORES.food, ...STORES.beauty]) ALLOWED.set(domain, name);

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
        if (type !== 'cotton' && type !== 'food' && type !== 'beauty') return json({error: 'type must be cotton, food or beauty'}, 400);
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
      if (u.pathname === '/translate'){
        const q = (u.searchParams.get('q') || '').slice(0, 500).trim();
        if (!q) return json({error: 'Add text to translate, for example /translate?q=chips de bananes'}, 400);
        const r = await fetch('https://translate.googleapis.com/translate_a/single?' + new URLSearchParams({client: 'gtx', sl: 'auto', tl: 'en', dt: 't', q}), {headers: UA, cf: {cacheTtl: 604800, cacheEverything: true}});
        if (!r.ok) return json({error: `Translation answered HTTP ${r.status}`}, 502, 0);
        const j = await r.json();
        return json({text: (j[0] || []).map(x => x[0]).join(''), from: j[2] || ''}, 200, 604800);
      }
      if (u.pathname === '/kroger'){
        const q = (u.searchParams.get('q') || '').slice(0, 80).trim();
        if (!q) return json({error: 'Add a search, for example /kroger?q=organic dried mango'}, 400);
        if (!env.KROGER_ID || !env.KROGER_SECRET) return json({error: 'Kroger is not set up yet: add Worker secrets KROGER_ID (your client ID) and KROGER_SECRET (your client secret).'}, 501, 0);
        return json({items: await krogerSearch(q, env, u.searchParams.get('type') === 'beauty' ? 'beauty' : 'food')}, 200, 21600);
      }
      if (u.pathname === '/etsy'){
        const q = (u.searchParams.get('q') || '').slice(0, 80).trim();
        if (!q) return json({error: 'Add a search, for example /etsy?q=100% cotton dress'}, 400);
        const etype = u.searchParams.get('type') === 'food' ? 'food' : u.searchParams.get('type') === 'beauty' ? 'beauty' : 'cotton';
        if (!env.ETSY_KEY) return json({error: 'Etsy is not set up yet: add Worker secrets ETSY_KEY (your keystring) and ETSY_SECRET (your shared secret).'}, 501, 0);
        const ekey = env.ETSY_KEY.includes(':') ? env.ETSY_KEY : `${env.ETSY_KEY}:${env.ETSY_SECRET || ''}`;
        return json({items: await etsySearch(q, ekey, etype)}, 200, 21600);
      }
      if (u.pathname === '/details'){
        const target = new URL(u.searchParams.get('url') || '');
        if (!ALLOWED.has(target.hostname) || target.protocol !== 'https:') return json({error: 'Only product pages from PureFinds stores can be read.'}, 400);
        return json(await details(target, env, u.searchParams.get('long') === '1'), 200, 86400);
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
  const keep = ps => ps.map(p => type === 'cotton' ? cottonItem(d, p) : type === 'beauty' ? beautyItem(d, p) : foodItem(d, p)).filter(Boolean);
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
// Etsy Open API v3: search active listings, then read them in one batch with photos and shop names.
// The x-api-key header is "keystring:sharedsecret" (required by Etsy since Feb 2026).
async function etsySearch(q, key, type){
  const H = {...UA, 'x-api-key': key}, cf = {cacheTtl: 21600, cacheEverything: true};
  const ask = async url => { const r = await fetch(url, {headers: H, cf}); if (!r.ok){ let why = ''; try { const j = await r.json(); why = ': ' + (j.error || j.message || ''); } catch (e){} throw new Error(`Etsy answered HTTP ${r.status}${why}`); } return r.json(); };
  const found = await ask('https://openapi.etsy.com/v3/application/listings/active?' + new URLSearchParams({keywords: q, limit: '100', sort_on: 'score'}));
  const ids = (found.results || []).map(l => l.listing_id).filter(Boolean);
  if (!ids.length) return [];
  let full = found.results;
  try { full = (await ask('https://openapi.etsy.com/v3/application/listings/batch?' + new URLSearchParams({listing_ids: ids.join(','), includes: 'Images,Shop'}))).results || full; } catch (e){}
  const out = [];
  for (const l of full){
    if (l.state && l.state !== 'active') continue;
    const title = plain(l.title), desc = plain(l.description), kind = `${l.title} ${(l.tags || []).join(' ')} ${(l.taxonomy_path || []).join(' ')}`;
    const price = l.price && l.price.divisor && (!l.price.currency_code || l.price.currency_code === 'USD') ? l.price.amount / l.price.divisor : null; // other currencies (rupees, lira) would show as dollars
    const row = {
      domain: 'etsy.com', store: 'Etsy', vendor: (l.shop && l.shop.shop_name) || 'Etsy seller', handle: String(l.listing_id), name: title,
      url: String(l.url || `https://www.etsy.com/listing/${l.listing_id}`).split('?')[0], img: ((l.images || [])[0] || {}).url_570xN || '', price,
      ptype: (l.taxonomy_path || []).join(' '), tags: l.tags || [], created: l.creation_timestamp ? new Date(l.creation_timestamp * 1000).toISOString() : ''
    };
    if (type === 'food'){
      if (NOT_FOOD.test(title) || NOT_FOOD_THING.test(`${title} ${row.ptype}`) || /\b(digital|printable|pattern|svg|png|pdf|download|template|charm|earrings?|necklace|keychain|soap|candle|bath|scrub|lotion|balm|toy|plush|dog|cat|pet)\b/i.test(kind)) continue;
      if (!/food|baked|cookie|snack|candy|granola|bread|cracker|flour|sugar|syrup|spice|fruit|nut|almond|walnut|maple|date|cacao|cocoa|chocolate/i.test(kind)) continue;
      // Etsy sellers often put the ingredients in the "materials" field; otherwise look in the description
      const mats = (l.materials || []).map(String).filter(Boolean);
      const ing = findIngredients(plainList(l.description)) || (mats.length >= 2 ? mats.join(', ') : '');
      const all = `${title} ${desc} ${(l.tags || []).join(' ')}`;
      out.push({...row, organic: /usda[- ]organic/i.test(all) ? 'USDA Organic' : /certified organic/i.test(all) ? 'Certified organic' : /\borganic\b/i.test(all) ? 'Organic (seller wording)' : '',
        nonGmo: /non[- ]?gmo/i.test(all) ? 'Non-GMO (seller claim)' : '', ing, ingSrc: ing ? (findIngredients(plainList(l.description)) ? 'Etsy listing' : 'Etsy listing (materials)') : '', desc: desc.slice(0, 400), barcode: ''});
      continue;
    }
    if (type === 'beauty'){
      if (NOT_BEAUTY.test(title) || /\b(digital|printable|pattern|svg|png|pdf|download|template|charm|earrings?|necklace|keychain|candle|wax|melt|toy|plush|dog|cat|pet|incense|cutter|stencil|sticker|decal|nail (art|wraps?|stickers?|tips|files?|clippers?)|press[- ]on|fake nails|jewelry)\b/i.test(kind)) continue;
      if (!/skin|face|facial|nail|polish|lacquer|hair|serum|cream|lotion|balm|moisturi|cleanser|toner|mask|scrub|oil|butter|shampoo|conditioner|lip|sunscreen|deodorant|soap/i.test(kind)) continue;
      const mats = (l.materials || []).map(String).filter(Boolean);
      const ing = findIngredients(plainList(l.description), true) || (mats.length >= 3 ? mats.join(', ') : '');
      out.push({...row, ing, ingSrc: ing ? 'Etsy listing' : '', desc: desc.slice(0, 300)});
      continue;
    }
    const f = pureFabric(desc) || pureFabric(title);
    if (!f || OTHER_FIBERS && new RegExp('\\b(' + OTHER_FIBERS + ')\\b', 'i').test(`${title} ${desc}`) || !CLOTHING.test(kind) || NOT_CLOTHING.test(l.title || '')) continue;
    out.push({...row, fabric: f.line, material: f.material, sizes: [], colors: []});
  }
  return out;
}

/* ---------- Kroger (Kroger, Ralphs, Fred Meyer, King Soopers, Harris Teeter, Smith's and the rest of the family) ----------
   Public Products API, client-credentials sign-in. Kroger doesn't publish ingredient lists through its API, so each product's
   barcode is looked up on Open Food Facts in one batch. Prices only come back for a store: add a KROGER_LOCATION secret for that. */
let krogerToken = null;
async function krogerAuth(env){
  if (krogerToken && krogerToken.until > Date.now() + 60e3) return krogerToken.v;
  const id = String(env.KROGER_ID || '').trim(), secret = String(env.KROGER_SECRET || '').trim();
  const ask = host => fetch(`https://${host}/v1/connect/oauth2/token`, {method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + btoa(`${id}:${secret}`)},
    body: 'grant_type=client_credentials&scope=product.compact'});
  let r = await ask('api.kroger.com');
  if (!r.ok){
    let why = ''; try { const j = await r.json(); why = j.error_description || j.error || ''; } catch (e){}
    let hint = ` (ID is ${id.length} characters starting "${id.slice(0, 10)}", secret is ${secret.length} characters)`;
    if (r.status === 401){ try { const c = await ask('api-ce.kroger.com'); if (c.ok) hint = ' These keys work on Kroger\'s Certification (test) system, not Production. Make a new Kroger app and choose Production.'; } catch (e){} }
    throw new Error(`Kroger sign-in answered HTTP ${r.status}: ${why}.${hint}`);
  }
  const j = await r.json(); krogerToken = {v: j.access_token, until: Date.now() + (j.expires_in || 1800) * 1000}; return krogerToken.v;
}
// Kroger's 13-digit UPCs leave off the check digit; Open Food Facts needs it
const upcCandidates = raw => {
  const d = String(raw || '').replace(/\D/g, ''); if (!d) return [];
  const body = d.replace(/^0+/, '').padStart(11, '0').slice(-11);
  let sum = 0; for (let i = 0; i < 11; i++) sum += (+body[i]) * (i % 2 === 0 ? 3 : 1);
  const upcA = body + ((10 - sum % 10) % 10);
  return [...new Set([upcA, '0' + upcA, d, d.replace(/^0+/, '')])].filter(x => x.length >= 8);
};
async function krogerSearch(q, env, type){
  const token = await krogerAuth(env);
  const p = new URLSearchParams({'filter.term': q, 'filter.limit': '50'}); if (env.KROGER_LOCATION) p.set('filter.locationId', env.KROGER_LOCATION);
  let r = await fetch('https://api.kroger.com/v1/products?' + p, {headers: {'Accept': 'application/json', 'Authorization': 'Bearer ' + token}, cf: {cacheTtl: 21600, cacheEverything: true}});
  for (let t = 0; t < 2 && r.status >= 500; t++){ await new Promise(ok => setTimeout(ok, 700 * (t + 1))); r = await fetch('https://api.kroger.com/v1/products?' + p, {headers: {'Accept': 'application/json', 'Authorization': 'Bearer ' + token}}); }
  if (!r.ok){ if (r.status === 401) krogerToken = null; throw new Error(`Kroger answered HTTP ${r.status}`); }
  const list = (await r.json()).data || [];
  // one Open Food Facts request for every barcode in the batch
  const codes = new Map(); for (const k of list) for (const c of upcCandidates(k.upc)) codes.set(c, k.productId);
  const off = new Map();
  if (codes.size) try {
    const j = await getJSON(`https://world.${type === 'beauty' ? 'openbeautyfacts' : 'openfoodfacts'}.org/api/v2/search?` + new URLSearchParams({code: [...codes.keys()].join(','), page_size: '200', fields: 'code,ingredients_text_en,ingredients_text,labels_tags'}));
    for (const pr of j.products || []){ const id = codes.get(String(pr.code)); if (id && !off.has(id)) off.set(id, pr); }
  } catch (e){}
  const out = [];
  for (const k of list){
    const name = plain(k.description), brand = plain(k.brand) || 'Kroger';
    if (!name || (type === 'beauty' ? NOT_BEAUTY.test(name) : (NOT_FOOD.test(name) || NOT_FOOD_THING.test(name)))) continue;
    const o = off.get(k.productId) || {}, L = o.labels_tags || [];
    const organic = /organic/i.test(`${name} ${brand}`) || L.some(t => /organic/.test(t)) ? (L.includes('en:usda-organic') ? 'USDA Organic' : 'Organic (label wording)') : '';
    const nonGmo = L.some(t => /non-gmo-project/.test(t)) ? 'Non-GMO Project Verified' : L.some(t => /gmo/.test(t)) || /non[- ]?gmo/i.test(name) ? 'Non-GMO label' : '';
    if (type !== 'beauty' && !organic && !nonGmo) continue; // PureFinds only lists organic or Non-GMO food; beauty is judged by its ingredients instead
    const ing = plain(o.ingredients_text_en || o.ingredients_text || '');
    const im = (k.images || []).find(i => i.perspective === 'front') || (k.images || [])[0] || {};
    const size = (im.sizes || []).find(s => s.size === 'large') || (im.sizes || []).find(s => s.size === 'medium') || (im.sizes || [])[0] || {};
    const it = (k.items || [])[0] || {}, pr = it.price || it.nationalPrice || {};
    out.push({domain: 'kroger.com', store: 'Kroger', vendor: brand, handle: String(k.productId), name, url: k.productPageURI ? 'https://www.kroger.com' + k.productPageURI : `https://www.kroger.com/p/item/${k.productId}`,
      img: size.url || '', price: pr.promo || pr.regular || null, ptype: (k.categories || []).join(' '), tags: [], created: '', organic, nonGmo,
      ing, ingSrc: ing ? 'Open Food Facts record for this barcode' : '', desc: `${brand} · ${it.size || ''}`, barcode: String(k.upc || '')});
  }
  return out;
}

/* ---------- organic or Non-GMO food ---------- */
const NOT_FOOD = /gift ?card|bundle|sampler|merch|tote|t-shirt|sweatshirt|\bhat\b|\bmug\b|apron|subscription box|e-?gift/i;
const NOT_FOOD_THING = /\b(baking\s+scale|kitchen\s+scale|scales?|pans?|sheet\s+pan|baking\s+(sheet|stone|mat|dish|tray)|trays?|molds?|moulds?|(cake|muffin|baking|loaf|pie)\s+tins?|ramekins?|whisks?|spatulas?|rolling\s+pins?|spoons?|ladles?|tongs|knives|knife|cutting\s+boards?|boards?|bowls?|mugs?|cups?\s+set|measuring\s+(cups?|spoons?)|thermometers?|timers?|bannetons?|proofing\s+baskets?|baskets?|lames?|scrapers?|sifters?|strainers?|colanders?|graters?|peelers?|grinders?|grain\s+mills?|blenders?|mixers?|machines?|appliances?|kettles?|teapots?|infusers?|tumblers?|water\s+bottles?|jars?\s+(set|only)|storage\s+(canisters?|containers?)|towels?|cloths?|aprons?|oven\s+mitts?|pot\s+holders?|cookbooks?|books?|recipe\s+cards?|posters?|prints?|stickers?|magnets?|candles?|ornaments?|gift\s+cards?|e-?gift|totes?|bags?\s+(reusable|canvas|cotton)|t-?shirts?|hoodies?|hats?|socks|merch|subscriptions?|memberships?|classes?|workshops?|vouchers?)\b/i; // kitchen tools, books and merch sold next to the food
const ING_STOP = /\s(?:contains|allergen|allergy|nutrition facts|directions|how to use|storage|store in|net wt|suggested use|manufactured|produced in|made in a facility|may contain|frequently asked|reviews|you may also|add to cart|shipping|distributed by|product testing|find in store|where to buy|customer reviews|write a review|add to bag|free shipping|you might also like|related products|nutrition|how to|faq)\b/i;
// Real ingredient lists are plain words and commas, never page code or store data
const looksLikeIngredients = (t, long) => {
  t = String(t || '').trim();
  if (!t || /[{}\[\]"<>=_\\|]|https?:|\b(sku|variant|price|product_id|compare_at|handle|json|null|true|false)\b/i.test(t) || t.split(/\s+/).length > (long ? 700 : 160)) return false;
  // marketing sentences are not ingredient lists ("each selected for maximum deliciousness")
  if (/\b(delicious\w*|selected|crafted|enjoy\w*|perfect\w*|our|we|you\w*|maximum|favorite|love\w*|each)\b/i.test(t)) return false;
  const parts = t.split(/[,;]/).map(x => x.trim()).filter(Boolean);
  return parts.length >= 2 || (parts.length === 1 && t.split(/\s+/).length <= 8 && !/\.\s*$/.test(t));
};
const NAV_WORD = /\b(shop|cart|login|log in|sign in|account|search|menu|subscribe|contact|about us|our story|blog|careers|press|privacy|terms|shipping|returns|wholesale|store locator|recipes)\b/i;
function findIngredients(text, long){
  // The heading is often "Ingredients:", but accordions show just "Ingredients" followed by + or −, with no colon at all.
  // "Simple Ingredients" and "Full Ingredients" headings work the same way.
  const re = /\bingredients?\b[\s:\-–—+−×▼▲>|]*/gi; let m;
  const tidy = s => s.replace(/^[\s,.:;+−\-–]+|[\s,.:;+−\-–]+$/g, '').replace(/\s*,\s*(,\s*)+/g, ', ').replace(/\s+/g, ' ');
  const good = rest => {
    const parts = rest.split(/,/).map(x => x.trim()).filter(Boolean);
    return rest.length > 2 && looksLikeIngredients(rest, long) && !NAV_WORD.test(rest) && parts.length <= (long ? 220 : 70) && parts.every(x => x.split(' ').length <= (long ? 18 : 14))
      && (rest.includes(',') || /organic/i.test(rest) || rest.split(' ').length <= 6);
  };
  while ((m = re.exec(text))){
    let rest = text.slice(m.index + m[0].length, m.index + m[0].length + (long ? 4500 : 1200));
    const stop = rest.search(ING_STOP); if (stop > 0) rest = rest.slice(0, stop);
    rest = tidy(rest);
    if (rest.length > 6 && good(rest)) return rest.slice(0, long ? 3500 : 900);
    // The list often runs straight into the next part of the page. Try it as one sentence, then two, so the page text after it is dropped.
    const sents = rest.split(/(?<=[.!?])\s+/).map(s => tidy(s)).filter(Boolean);
    for (const n of [1, 2]){
      const cand = tidy(sents.slice(0, n).join('. '));
      if (cand.length > 2 && good(cand)) return cand.slice(0, long ? 3500 : 900);
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
/* ---------- beauty: skin, face, nail and hair care ---------- */
const NOT_BEAUTY = /gift ?card|e-?gift|\b(sets?|kits?|bundles?|duos?|trios?|discovery|collection|sampler|samples?|subscription|refill pouch)\b|\b(brush(es)?|sponges?|applicators?|tote|bag|pouch|headband|scrunchie|bonnet|mirror|tool|comb|roller|gua sha|candle|sticker|t-?shirt|hoodie|merch|cap|hat)\b/i;
function beautyItem(d, p){
  const title = p.title || '';
  if (NOT_BEAUTY.test(`${title} ${p.product_type || ''}`) || !available(p)) return null;
  const text = plain(p.body_html), b = base(d, p), listText = plainList(p.body_html);
  return {...b, ing: findIngredients(listText, true), desc: text.slice(0, 300)};
}
function barcodeOf(p){
  const v = (p.variants || []).find(v => /^\d{8,14}$/.test(String(v.barcode || '')));
  if (v) return String(v.barcode);
  for (const im of p.images || []){ const m = String(im.src || '').match(/(?:^|[^\d])(\d{12,13})(?:[^\d]|$)/); if (m) return m[1]; }
  return '';
}

/* ---------- details for one product (opened when a listing is tapped) ---------- */
async function details(target, env, long){
  const d = target.hostname, handle = target.pathname.startsWith('/products/') ? target.pathname.split('/')[2] : '';
  const out = {url: target.href, ingredients: '', ingredientsSource: '', fabric: '', barcode: '', tried: []};
  // 1. the product's data file (Shopify stores)
  if (handle) try {
    const p = (await getJSON(`https://${d}/products/${handle}.json`)).product || {};
    const text = plain(p.body_html);
    out.ingredients = findIngredients(plainList(p.body_html), long); out.fabric = ((pureFabric(text) || {}).line) || ''; out.barcode = barcodeOf(p);
    if (out.ingredients) out.ingredientsSource = 'Product description';
  } catch (e){ out.tried.push(String(e.message || e)); }
  // 2. the product page itself (ingredients are often in a tab or accordion)
  if (!out.ingredients){
    try {
      const r = await fetch(target.href, {headers: PAGE_UA, cf: {cacheTtl: 86400, cacheEverything: true, cacheKey: target.href + '#page2'}});
      if (!r.ok) throw new Error(`${d} page answered HTTP ${r.status}`);
      const html = await r.text(), text = plain(html);
      out.ingredients = findIngredients(plainList(html), long);
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
