-- Seeded from the PRODUCTS array in index.html. Slugs are carried over unchanged
-- and are permanent — they appear in ?p= links and in saved carts.
-- Prices are centavos: ₱850 -> 85000.
-- Glass pieces are one-of-a-kind, so their low-stock threshold is 0.

insert into products (
  slug, name, category, tag, price_cents, status, stock_on_hand, low_stock_at,
  one_of_a_kind, blurb, description, dimensions, materials, care, lead_time,
  bg_color, tape_color, sort_order
) values
(
  'peach-sky-glass-panel', 'Peach Sky Glass Panel', 'glass', 'Glass painting', 85000, 'active', 1, 0, true,
  'A pocket-size sunset painted one soft layer at a time.',
  'A dreamy peach-and-blue sky painted in reverse on a clear glass panel, so every brushstroke glows through the front. The tiny clouds and hand-finished edges make this one-off piece especially sweet on a sunny shelf.',
  '12 × 12 cm · 4 mm glass',
  'Reverse-painted acrylic on tempered glass, sealed matte',
  'Wipe with a dry cloth. Do not submerge. Keep out of direct sun.',
  'Ships in 2–3 days', '#FFD9EC', '#FFD166', 0
),
(
  'star-cookie-charm', 'Star Cookie Charm', 'charms', 'Keychain', 28000, 'active', 4, 2, false,
  'A sprinkle-bright star for keys, bags, and little adventures.',
  'A hand-assembled star charm inspired by iced sugar cookies, finished with a cheerful mix of glass and acrylic beads. Bead placement varies slightly, so each charm has its own tiny personality.',
  'Approx. 11 cm long · 3.5 cm charm',
  'Resin charm, glass and acrylic beads, zinc-alloy clasp',
  'Keep dry and avoid perfume or alcohol. Wipe hardware gently after use.',
  'Ships in 2–3 days', '#DFF4FE', '#7ED3F2', 1
),
(
  'cloud-bead-bracelet', 'Cloud Bead Bracelet', 'charms', 'Accessory', 32000, 'active', 3, 2, false,
  'Pastel beads and a tiny cloud for soft-sky days.',
  'This stretch bracelet pairs milky glass beads with pastel accents and a miniature cloud centerpiece. Each strand is balanced and knotted by hand for an easy everyday stack.',
  'Fits wrists 15–17 cm · 8 mm beads',
  'Glass and acrylic beads, elastic cord',
  'Roll on and off instead of stretching. Keep dry and store away from direct sun.',
  'Ships in 2–3 days', '#FFE1EF', '#FFB6D9', 2
),
(
  'sweetheart-sticker-pack', 'Sweetheart Sticker Pack', 'stickers', '6 die-cuts', 18000, 'active', 8, 2, false,
  'Six glossy little love notes for journals and gadgets.',
  'A set of six hand-drawn hearts, ribbons, and candy-bright doodles, printed in saturated color and cut individually. The glossy finish makes them perfect for notebooks, phone cases, and happy-mail envelopes.',
  '6 die-cuts · 4–6 cm each',
  'Gloss-laminated waterproof vinyl',
  'Apply to a clean, dry surface. Hand-wash decorated bottles; do not soak.',
  'Ships in 1–2 days', '#FFF0C7', '#FFD166', 3
),
(
  'little-daisy-glass-cup', 'Little Daisy Glass Cup', 'glass', 'Glass painting', 62000, 'active', 1, 0, true,
  'A garden of tiny daisies wrapped around your favorite drink.',
  'A clear tumbler dotted with individually painted white daisies and sunny yellow centers. The flowers are sealed by hand, leaving the rim and inside completely paint-free.',
  '350 ml · 10.5 × 7.5 cm',
  'Soda-lime glass, cured glass paint, food-safe exterior seal',
  'Hand-wash gently with a soft sponge. Do not soak, microwave, or dishwash.',
  'Ships in 3–4 days', '#F3FBE7', '#FFB6D9', 4
),
(
  'sparkle-phone-charm', 'Sparkle Phone Charm', 'charms', 'Accessory', 26000, 'active', 5, 2, false,
  'A candy-colored wrist loop with just enough sparkle.',
  'A lightweight phone charm strung with translucent stars, pearly beads, and playful pastel accents. Every loop is arranged by hand and finished with reinforced cord at the phone tab.',
  'Approx. 18 cm loop · 6 mm cord end',
  'Acrylic and glass beads, nylon cord',
  'Use as a wrist loop, not a drop-proof strap. Keep dry and avoid sharp pulls.',
  'Ships in 2–3 days', '#EDE3FF', '#7ED3F2', 5
),
(
  'cloud-nine-vinyl-sheet', 'Cloud Nine Vinyl Sheet', 'stickers', 'Sticker sheet', 15000, 'active', 0, 2, false,
  'Tiny clouds, stars, and daydreams on one cheerful sheet.',
  'A kiss-cut sheet filled with soft blue clouds, pink stars, and miniature sky-day doodles. The compact stickers are sized for planners, pen-pal letters, and all the awkward little notebook gaps.',
  '10 × 15 cm sheet · 18 stickers',
  'Gloss-laminated waterproof vinyl',
  'Peel slowly from the edge and apply to a clean, dry surface.',
  'Ships in 1–2 days', '#E7F7FF', '#EF4056', 6
),
(
  'cherry-red-mini-frame', 'Cherry Red Mini Frame', 'glass', 'Glass painting', 54000, 'active', 1, 0, true,
  'A bright pair of cherries framed for the smallest happy corner.',
  'Two glossy red cherries are reverse-painted onto glass and set into a hand-finished mini frame. The bold color and tiny scale make it a playful desk piece or an easy handmade gift.',
  '9 × 11 cm framed · 3 mm glass',
  'Reverse-painted glass, acrylic paint, sealed wood-composite frame',
  'Dust with a soft dry cloth. Keep away from moisture and direct sun.',
  'Ships in 2–3 days', '#FFDCD9', '#FFD166', 7
)
on conflict (slug) do nothing;

-- Opening balance for the ledger. Cloud Nine ships sold out, and delta <> 0 is a
-- constraint, so this correctly skips it.
insert into stock_movements (product_id, delta, reason, note, created_by)
select id, stock_on_hand, 'initial', 'Seeded from the storefront PRODUCTS array', 'seed'
from products
where stock_on_hand > 0
  and not exists (select 1 from stock_movements m where m.product_id = products.id);
