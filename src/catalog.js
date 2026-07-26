// Server-side price list. The client never gets to name a price.
//
// MUST STAY IN SYNC with `PRODUCTS` in index.html — same ids, same numbers.
// Ids are permanent: they appear in ?p= deep links and saved carts.
//
// TODO: generate this and PRODUCTS from one products.json at build time.

export const CATALOG = {
  'peach-sky-glass-panel': { name: 'Peach Sky Glass Panel', price: 850 },
  'star-cookie-charm': { name: 'Star Cookie Charm', price: 280 },
  'cloud-bead-bracelet': { name: 'Cloud Bead Bracelet', price: 320 },
  'sweetheart-sticker-pack': { name: 'Sweetheart Sticker Pack', price: 180 },
  'little-daisy-glass-cup': { name: 'Little Daisy Glass Cup', price: 620 },
  'sparkle-phone-charm': { name: 'Sparkle Phone Charm', price: 260 },
  'cloud-nine-vinyl-sheet': { name: 'Cloud Nine Vinyl Sheet', price: 150 },
  'cherry-red-mini-frame': { name: 'Cherry Red Mini Frame', price: 540 }
};

export const peso = (n) => '₱' + n.toLocaleString('en-PH');
