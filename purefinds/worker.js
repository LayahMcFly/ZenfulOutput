// PureFinds store scanner, a Cloudflare Worker (works on the free plan).
// Paste this whole file into a Worker named "purefinds" and press Deploy.
//
//   /stores                     the store list
//   /store?d=kotn.com&type=cotton   one store's 100% cotton clothing
//   /store?d=lesserevil.com&type=food   one store's organic or Non-GMO food
//   /details?url=<product page>  ingredients (or fabric) read from the product's own page,
//                                with Open Food Facts as a backup when the page doesn't list them
//
// Optional: add a secret named FDC_KEY (free key from fdc.nal.usda.gov/api-key-signup)
// and the scanner also checks USDA FoodData Central for missing ingredient lists.

const VERSION = '1.1.2';

// Add or remove stores here. Each must be a Shopify store (most brand websites are).
const STORES = {
  cotton: [
    ['kotn.com', 'Kotn'], ['christydawn.com', 'Christy Dawn'], ['matethelabel.com', 'MATE the Label'],
    ['ladywhiteco.com', 'Lady White Co.'], ['cottonique.com', 'Cottonique'], ['losangelesapparel.net', 'Los Angeles Apparel'],
    ['www.jennikayne.com', 'Jenni Kayne'], ['shopdoen.com', 'DÔEN'], ['www.hillhousehome.com', 'Hill House Home'],
    ['printfresh.com', 'Printfresh'], ['sleepyjones.com', 'Sleepy Jones'], ['colorfulstandard.com', 'Colorful Standard'],
    ['harvestandmill.com', 'Harvest & Mill'], ['theclassictshirt.com', 'The Classic T-Shirt Company'],
    ['organicbasics.com', 'Organic Basics'], ['merzbschwanen.com', 'Merz b. Schwanen'], ['babaa.es', 'Babaà'],
    ['tradlands.com', 'Tradlands'], ['outerknown.com', 'Outerknown']
  ],
  food: [
    ['yumearth.com', 'YumEarth'], ['www.theochocolate.com', 'Theo Chocolate'], ['lesserevil.com', 'LesserEvil'],
    ['mavunoharvest.com', 'Mavuno Harvest'], ['www.marysgonecrackers.com', "Mary's Gone Crackers"],
    ['purelyelizabeth.com', 'Purely Elizabeth'], ['onceuponafarmorganics.com', 'Once Upon a Farm'],
    ['www.alterecofoods.com', 'Alter Eco'], ['madegoodfoods.com', 'Made Good'], ['hukitchen.com', 'Hu Kitchen'],
    ['healthyflour.com', 'To Your Health Sprouted Flour'], ['shilohfarms.com', 'Shiloh Farms'],
    ['jovialfoods.com', 'Jovial'], ['yolele.com', 'Yolélé'], ['onedegreeorganics.com', 'One Degree Organic Foods'],
    ['www.bobsredmill.com', "Bob's Red Mill"], ['wildernesspoets.com', 'Wilderness Poets']
  ]
};
const ALLOWED = new Map();
for (const [domain, name] of [...STORES.cotton, ...STORES.food]) ALLOWED.set(domain, name);

const CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'};
const json = (o, status = 200, maxAge = 1800) => new Response(JSON.stringify(o), {
  status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${maxAge}`, ...CORS}
});
const UA = {'User-Agent': 'PureFinds/1.0 (personal shopping finder)', 'Accept': 'application/json,text/html'};

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

/* ---------- 100% cotton clothing ---------- */
const CLOTHING = /\b(dress|top|tee|t-shirt|shirt|blouse|tank|cami|sweater|cardigan|hoodie|sweatshirt|crewneck|pullover|pant|trouser|jogger|sweatpant|jean|short|skirt|pajama|pj|sleep|robe|nightgown|sock|underwear|brief|boxer|bra|bralette|legging|jacket|coat|overall|jumpsuit|romper|polo|henley|turtleneck|lounge|thong|bikini|hipster|longsleeve|knit)s?\b/i;
const NOT_CLOTHING = /\b(sheet|duvet|pillow|towel|blanket|quilt|napkin|tablecloth|bag|tote|gift ?card|candle|mug|scarf|beanie|hat|cap|arm sleeve|headband|mask)s?\b/i;
const COTTON_LINE = /[^.;!?]{0,60}100\s*%\s*(?:(?:certified|gots[- ]certified|organic|egyptian|pima|supima|combed|ring[- ]spun|japanese|japan|turkish|peruvian|regenerative(?:ly grown)?|us[- ]grown|american[- ]grown|heavyweight|brushed)\s+){0,3}cotton\b[^.;!?]{0,50}/i;
const BLEND = /\b(polyester|spandex|elastane|lycra|nylon|acrylic|rayon|viscose|lyocell|tencel|modal|cupro|wool|merino|alpaca|cashmere|mohair|linen|hemp|silk|bamboo|lurex|metallic|polyamide|elasterell)\b/i;
function cottonItem(d, p){
  const title = p.title || '', kind = `${p.product_type || ''} ${title}`;
  if (!CLOTHING.test(kind) || NOT_CLOTHING.test(kind) || !available(p)) return null;
  const text = plain(p.body_html), m = text.match(COTTON_LINE);
  if (!m || BLEND.test(text)) return null;
  return {...base(d, p), fabric: m[0].trim(), sizes: optionValues(p, /size/i), colors: optionValues(p, /colou?r/i)};
}

/* ---------- organic or Non-GMO food ---------- */
const NOT_FOOD = /gift ?card|bundle|sampler|merch|tote|t-shirt|sweatshirt|\bhat\b|\bmug\b|apron|subscription box|e-?gift/i;
const ING_STOP = /\s(?:contains|allergen|allergy|nutrition facts|directions|how to use|storage|store in|net wt|suggested use|manufactured|produced in|made in a facility|may contain|frequently asked|reviews|you may also|add to cart|shipping|distributed by)\b/i;
// Real ingredient lists are plain words and commas, never page code or store data
const looksLikeIngredients = t => !/[{}\[\]"<>=_\\|]|https?:|\b(sku|variant|price|product_id|compare_at|handle|json|null|true|false)\b/i.test(t) && t.split(/\s+/).length <= 160;
function findIngredients(text){
  const re = /ingredients?\s*[:\-–]\s*/gi; let m;
  while ((m = re.exec(text))){
    let rest = text.slice(m.index + m[0].length, m.index + m[0].length + 900);
    const stop = rest.search(ING_STOP); if (stop > 0) rest = rest.slice(0, stop);
    rest = rest.replace(/\s*\.\s*$/, '').trim();
    if (rest.length > 6 && looksLikeIngredients(rest) && (rest.includes(',') || /organic/i.test(rest) || rest.split(' ').length <= 6)) return rest.slice(0, 700);
  }
  return '';
}
function foodItem(d, p){
  const title = p.title || '';
  if (NOT_FOOD.test(`${title} ${p.product_type || ''}`) || !available(p)) return null;
  const text = plain(p.body_html), b = base(d, p), all = `${title} ${text} ${b.tags.join(' ')}`;
  const organic = /usda[- ]organic/i.test(all) ? 'USDA Organic' : /certified organic/i.test(all) ? 'Certified organic' : /\borganic\b/i.test(all) ? 'Organic (brand wording)' : '';
  const nonGmo = /non[- ]?gmo project/i.test(all) ? 'Non-GMO Project Verified' : /non[- ]?gmo/i.test(all) ? 'Non-GMO (brand claim)' : '';
  if (!organic && !nonGmo) return null;
  return {...b, organic, nonGmo, ing: findIngredients(text), desc: text.slice(0, 400), barcode: barcodeOf(p)};
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
    out.ingredients = findIngredients(text); out.fabric = (text.match(COTTON_LINE) || [''])[0].trim(); out.barcode = barcodeOf(p);
    if (out.ingredients) out.ingredientsSource = 'Product description';
  } catch (e){ out.tried.push(String(e.message || e)); }
  // 2. the product page itself (ingredients are often in a tab or accordion)
  if (!out.ingredients){
    try {
      const r = await fetch(target.href, {headers: UA, cf: {cacheTtl: 86400, cacheEverything: true}});
      if (!r.ok) throw new Error(`${d} page answered HTTP ${r.status}`);
      const html = await r.text(), text = plain(html);
      out.ingredients = findIngredients(text);
      if (out.ingredients) out.ingredientsSource = 'Product page';
      if (!out.fabric) out.fabric = (text.match(COTTON_LINE) || [''])[0].trim();
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
