# Verre — Build Plan: Cart, Forms, Product Detail

**Status:** ready to start
**Implementer:** Codex
**Author of spec:** Claude
**Last updated:** 2026-07-26

---

## 0. Read this first

This repo is **not** a normal React project. Do not `npm install react`, do not add a bundler, do not convert anything to JSX. Read §1 before writing a single line.

### The three goals

| # | Feature | Why |
|---|---------|-----|
| 1 | **Real cart** | Today `state.cart` is an integer counter. Clicking "Add to cart" increments a number and the cart button just scrolls to `#shop`. Nothing is stored, nothing can be reviewed or removed. |
| 2 | **Working forms** | The custom-order form calls `e.preventDefault(); this.setState({sent:true})`. Nothing is sent anywhere. Inquiries are silently lost. |
| 3 | **Product detail** | Products are cards with a name, tag and price. No dimensions, materials, care instructions, or extra photos — all of which handmade-glass buyers need before purchasing. |

### Decisions already made (do not re-litigate)

- **Form/email backend:** Cloudflare Worker → **Resend** API. The site already deploys to Cloudflare (`.openai/hosting.json`, `dist/server/index.js`). MailChannels ended its free Workers tier in 2024 — do not use it.
- **Checkout:** **Email order request.** The cart submits through the same Worker endpoint as inquiries. Kyle replies manually with payment instructions (GCash / bank transfer). **No Stripe, no card fields, no payment SDK in this phase.**
- **Product detail UI:** **Modal overlay**, not a separate page. URL-syncable via `?p=<slug>`.

---

## 1. Architecture constraints — violating these breaks the build

The page is rendered by a bespoke runtime called **dc** (`support.js`, 1911 lines, generated — **never edit `support.js`**).

### How a page is structured

`index.html` has exactly two meaningful regions:

1. `<x-dc> ... </x-dc>` — the **template**. HTML with mustache bindings.
2. `<script type="text/x-dc" data-dc-script data-props="...">` — the **logic**, which must define `class Component extends DCLogic`.

### Template directives available

Confirmed present in the runtime. Use only these:

| Directive | Usage |
|-----------|-------|
| `{{ expr }}` | Interpolate a value returned from `renderVals()` |
| `<sc-for list="{{ items }}" as="p" hint-placeholder-count="8">` | Loop |
| `<sc-if value="{{ flag }}" hint-placeholder-val="{{ false }}">` | Conditional |
| `sc-else` | Present in the runtime but **unused anywhere in this codebase.** Verify it works with a throwaway test before relying on it. The existing code uses the paired-`sc-if` pattern (`sent` / `notSent`) — prefer that. |
| `style-hover` / `style-focus` / `style-active` | Pseudo-state styles as inline-style strings |
| `onClick="{{ handler }}"` / `onSubmit="{{ handler }}"` | Handlers **must** be functions returned from `renderVals()` |
| `<helmet>` | Head content (fonts, `<style>`) |

### Rules

- **All state lives in `Component.state`.** Mutate only via `this.setState`.
- **`renderVals()` is the single bridge** between logic and template. Every `{{ name }}` in the template must be a key it returns.
- **Bindings may be React elements.** `renderVals` already returns `art: atlasPhoto(...)`, which is `React.createElement(...)`. Use this for anything the template can't express — but prefer template markup so the design stays editable.
- **`h = React.createElement`** is defined at the top of the script block. There is no JSX and no build step for the logic.
- **Styling is 100% inline** on elements. There are no utility classes. Match the surrounding style exactly — the file is one long inline-styled document and consistency matters more than elegance here.
- **No new runtime dependencies.** No npm packages reach the browser. `package.json` has one script (`build`) and zero dependencies. Keep it that way.

### Design tokens (copy these; do not invent new colors)

```
Pink       #F157A8    Pink light   #FFB6D9    Pink pale    #FFE0EE / #FFE1EF
Red        #EF4056    Cream        #FFF6F0    Ink          #3A2430
Muted ink  #7A5C6B    Faint ink    #B98AA0    Blue         #7ED3F2
Blue deep  #20475C    Yellow       #FFD166    Input bg     #FFFBFD

Display font: 'Shrikhand', cursive   (headings only)
Body font:    'Poppins', sans-serif
Radius:       999px pills · 14–34px cards · 16–18px inputs
Shadow idiom: 0 Npx 0 rgba(239,64,86,.28)  — hard offset "sticker" shadow, then a soft blur
Motion:       transition …18s cubic-bezier(.2,.9,.3,1.4)
```

### Accessibility floor (non-negotiable, the current site meets it)

- Every interactive element reachable by keyboard, with a visible focus ring (`:focus-visible` is already styled globally).
- `prefers-reduced-motion` is already respected in CSS and in `componentDidMount` — any new animation must respect it too.
- `aria-label` on icon-only buttons; `role="status"` + `aria-live` on async result messages.

---

## 2. File ownership — prevents collisions

| Path | Owner | Notes |
|------|-------|-------|
| `index.html` | Phases 0, B, C, D | The hot file. **Serialize all work here.** |
| `scripts/build.mjs` | Phase 0, Phase A | |
| `src/worker.js` | Phase A | **New file** |
| `support.js` | *nobody* | Generated. Never edit. |
| `dist/**` | *nobody* | Build output. Never edit by hand; never commit fixes here. |
| `assets/verre-photo-atlas.png` | Phase C (read-only) | 4×4 sprite atlas, 16 photos |
| `.dev.vars`, `.gitignore` | Phase A | Secrets must never be committed |

**Commit one phase per commit.** Message format: `feat(cart): …`, `fix(build): …`.

---

## PHASE 0 — Foundations

**Blocks everything. Do this first, alone, and get it reviewed before proceeding.**

### T0.1 — Fix the broken build

`scripts/build.mjs` line 14 reads:

```js
const page = await readFile(resolve(root, "Verre.dc.html"), "utf8");
```

That file does not exist. The page is `index.html`. `npm run build` currently throws `ENOENT`.

- [ ] Point the read at `index.html`
- [ ] `npm run build` exits 0 and regenerates `dist/client/index.html`, `dist/client/support.js`, `dist/client/assets/`, `dist/server/index.js`
- [ ] Add `dist/` to `.gitignore` if it is currently tracked, and remove it from the index (`git rm -r --cached dist`)

### T0.2 — Product data model

Products are currently anonymous inline objects with **string prices** (`price: '₱850'`) and no stable identity. Cart math and deep links both need this fixed.

Extract to a module-level `PRODUCTS` constant at the top of the script block (above `class Component`).

```js
const PRODUCTS = [
  {
    id: 'peach-sky-glass-panel',        // stable slug — used in ?p= and cart keys. NEVER change once shipped.
    name: 'Peach Sky Glass Panel',
    tag: 'Glass painting',
    category: 'glass',                  // 'glass' | 'charms' | 'stickers'
    price: 850,                         // NUMBER, in PHP. Formatting is a view concern.
    stock: 1,                           // 0 = sold out. One-of-a-kind pieces are 1.
    atlas: 0,                           // index into the 4x4 photo atlas
    gallery: [0, 8],                    // extra atlas indices for the detail modal
    bg: '#FFD9EC',
    tape: '#FFD166',
    m: -1.4,                            // tilt multiplier, existing convention
    blurb: 'One-line hook shown on the card.',
    description: '2–3 sentences. What it is, how it was made, what makes this one different.',
    dimensions: '12 × 12 cm · 4 mm glass',
    materials: 'Reverse-painted acrylic on tempered glass, sealed matte',
    care: 'Wipe with a dry cloth. Do not submerge. Keep out of direct sun.',
    leadTime: 'Ships in 2–3 days'
  },
  // …all 8 existing products
];

const peso = (n) => '₱' + n.toLocaleString('en-PH');
```

- [ ] All 8 existing products migrated with **no visual change to the card grid**
- [ ] Slugs are kebab-case, derived from the current names, and documented as immutable
- [ ] `renderVals` maps `PRODUCTS` → view objects (adding `rot`, `art`, `add`, formatted `priceLabel`) rather than holding view data in the source array
- [ ] Write real copy for `description` / `dimensions` / `materials` / `care`. Placeholder lorem is a **fail** — invent plausible, specific, consistent values (a sticker pack has no glass thickness).
- [ ] Diff the rendered page before/after: it must be pixel-identical

**Phase 0 acceptance:** `npm run build` succeeds; the page looks exactly as it did; `PRODUCTS` is the single source of truth.

---

## PHASE A — Worker & email API  *(independent — may run in parallel with B and C)*

Touches only `scripts/build.mjs` and new files. No `index.html` edits.

### T A.1 — Extract the Worker to a real source file

`build.mjs` currently emits `dist/server/index.js` from an inline template string. That is untenable once the Worker has real logic.

- [ ] Create `src/worker.js` containing the existing asset-serving `fetch` handler
- [ ] `build.mjs` copies `src/worker.js` → `dist/server/index.js` instead of writing a string literal
- [ ] Existing static-serving behaviour is unchanged (`/` → `/index.html`, everything else → `env.ASSETS`)

### T A.2 — `POST /api/inquiry`

Single endpoint, three message types.

**Request body:**

```jsonc
{
  "type": "order" | "custom" | "contact",   // required
  "name": "string",                          // required, 1–100
  "email": "string",                         // required, valid
  "phone": "string",                         // optional, 0–30
  "message": "string",                       // required for custom/contact, optional for order
  "fulfillment": "pickup" | "delivery" | "ship",  // required when type === 'order'
  "items": [                                 // required when type === 'order', 1–50 entries
    { "id": "slug", "qty": 2 }
  ],
  "hp": ""                                   // honeypot — must be empty
}
```

**Responses:**

| Status | Body | When |
|--------|------|------|
| `200` | `{ ok: true, ref: "VR-7K2M" }` | Sent. `ref` is a short human-readable reference. |
| `400` | `{ ok: false, error: "…", field: "email" }` | Validation failure |
| `429` | `{ ok: false, error: "Too many requests" }` | Rate limited |
| `502` | `{ ok: false, error: "…" }` | Resend rejected or timed out |

**Requirements:**

- [ ] **Never trust client prices.** The Worker holds its own copy of `{ id → { name, price } }` and recomputes the subtotal from `items[].id` + `qty`. Reject unknown ids with `400`. Any price the client sends is ignored.
  - Keep this table in `src/catalog.js`, imported by the Worker. Note in a comment that it must stay in sync with `PRODUCTS` in `index.html`. (A future phase can generate both from one JSON file — out of scope here, but leave a `TODO`.)
- [ ] **Validate everything.** Type whitelist, email regex, string length caps, `qty` is an integer 1–20, `items.length` ≤ 50. Reject non-JSON and bodies over 16 KB.
- [ ] **Honeypot:** non-empty `hp` returns `200 {ok:true}` without sending. Bots should not learn they were caught.
- [ ] **Rate limit:** max 5 requests per IP per 10 minutes, keyed on `CF-Connecting-IP`. Use a Durable Object or KV; if neither is provisioned, an in-memory `Map` in module scope is acceptable for now — **comment clearly that it resets on isolate recycling and is best-effort only.**
- [ ] **Send via Resend** (`POST https://api.resend.com/emails`) with `RESEND_API_KEY` from `env`. Never hardcode. Add `.dev.vars` to `.gitignore`.
- [ ] **Two emails per submission:**
  1. **To Kyle** — subject `[Verre] New {type} — {ref}`. Plaintext + HTML. For orders: itemized table, subtotal, fulfillment method, customer contact. `reply-to` set to the customer's address so replying just works.
  2. **To the customer** — a warm confirmation in Verre's voice, restating what they sent and setting the expectation ("I'll reply within 2–3 days with a quote and payment details"). Include `ref`.
- [ ] Wrap the Resend call in a timeout (8s). A failed customer-confirmation email must **not** fail the request if Kyle's copy already sent — log and return `200`.
- [ ] Method/CORS: `POST` only; `405` otherwise. Same-origin, so no permissive CORS headers.
- [ ] Never log full email bodies or API keys.

### T A.3 — Local dev + docs

- [ ] `wrangler dev` serves the site and the endpoint locally
- [ ] `.dev.vars.example` committed with `RESEND_API_KEY=` (empty)
- [ ] `README.md` gets a short **Setup** section: required secrets, how to set them (`wrangler secret put RESEND_API_KEY`), which domain must be verified in Resend, and where Kyle's notification address is configured
- [ ] Kyle's destination address is an env var (`OWNER_EMAIL`), not a literal

**Phase A acceptance:** `curl` against a local `wrangler dev` produces a real email for each of the three types; malformed and over-limit payloads are rejected with the documented shapes; no secret appears in git.

---

## PHASE B — Real cart  *(serialize with C and D — same file)*

### T B.1 — State

Replace `state.cart` (integer) with:

```js
state = {
  cart: [],          // [{ id: 'peach-sky-glass-panel', qty: 1 }] — order = insertion order
  cartOpen: false,
  // …form state from Phase D
}
```

- [ ] Derive everything else (count, subtotal, line items) inside `renderVals`. **Do not store derived values in state.**
- [ ] Persist to `localStorage` under key `verre.cart.v1`
- [ ] On mount, read it back **defensively**: wrap in `try/catch`, drop unknown ids (a product may have been removed), clamp `qty` to `1..min(20, stock)`. Corrupt JSON must never white-screen the page.
- [ ] Respect `stock`: `qty` can't exceed it; `stock: 0` disables the add button entirely

### T B.2 — Cart drawer

Right-side slide-out panel.

- [ ] Opens from the nav Cart button (currently it scrolls to `#shop` — remove that placeholder and its `// ponytail:` comment on line ~390)
- [ ] Closes on: X button, backdrop click, `Escape`
- [ ] `position:fixed`, above the nav's `z-index:50` and above the grain overlay's `z-index:60` — use `70`+
- [ ] Backdrop dims the page and blocks scroll on `<body>` while open. Restore `overflow` and scroll position on close.
- [ ] Focus moves into the drawer on open, is **trapped** while open, and returns to the Cart button on close
- [ ] Slide-in transition using the house cubic-bezier; **skipped** under `prefers-reduced-motion`
- [ ] Full width on mobile (`max-width:100%`), ~380px on desktop

**Line items:** thumbnail (reuse `atlasPhoto`), name, unit price, `−` / qty / `+` steppers, remove (×), line total.

**Footer:** subtotal, a note that shipping is quoted separately, and a primary **Request this order** button.

**Empty state:** friendly Verre-voice copy plus a "Browse the shop" link that closes the drawer and scrolls to `#shop`. Do not render a bare empty box.

### T B.3 — Add-to-cart feedback

- [ ] Adding an item already in the cart increments `qty` rather than adding a duplicate row
- [ ] Cart button badge shows total quantity; `aria-label` updates ("Cart, 3 items")
- [ ] Visible confirmation on add — either open the drawer, or a brief toast. Pick one and be consistent. A silent number change is not enough feedback.
- [ ] Announce cart changes to screen readers via an `aria-live="polite"` region

**Phase B acceptance:** add 3 different items, change quantities, remove one, reload the page — the cart survives exactly. Keyboard-only operation works end to end. Nothing in the existing page shifts or breaks when the drawer is closed.

---

## PHASE C — Product detail modal  *(serialize with B and D)*

### T C.1 — Modal

- [ ] Clicking a product card image or title opens the modal. **The "Add to cart" button on the card must keep working without opening the modal** — stop propagation.
- [ ] Card becomes keyboard-focusable and opens on `Enter`/`Space`. Do not nest a `<button>` inside another interactive element; restructure if needed.
- [ ] Centered dialog, scrollable body, `role="dialog"` + `aria-modal="true"` + `aria-labelledby` on the product name
- [ ] Same close affordances, focus trap, scroll lock, and z-index rules as the cart drawer — **share one implementation between the two overlays; do not write it twice.**

### T C.2 — Content

Two-column on desktop, stacked on mobile:

- **Left:** main photo from `gallery[0]` with thumbnail strip; clicking a thumb swaps the main image. Keyboard-navigable.
- **Right:** name, tag, price, stock badge (`One of a kind` / `Only 1 left` / `Sold out`), `description`, then a definition list of `dimensions`, `materials`, `care`, `leadTime`, and an add-to-cart button.

- [ ] Sold-out products show a disabled button reading "Sold out" and a "Request something similar" link to `#custom` that closes the modal first
- [ ] Adding from the modal closes it and gives the same feedback as Phase B

### T C.3 — URL sync

- [ ] Opening sets `?p=<slug>` via `history.pushState`; closing does `history.back()` or `replaceState` back to clean
- [ ] `popstate` closes/opens accordingly — the browser Back button must close the modal, not leave the page
- [ ] Loading `/?p=peach-sky-glass-panel` directly opens that product's modal on first paint
- [ ] An unknown slug is ignored silently and the URL is cleaned

**Phase C acceptance:** deep link works on a cold load; Back closes the modal; focus returns to the originating card; card add-to-cart still works without opening the modal.

---

## PHASE D — Wire the forms  *(depends on Phase A + Phase B)*

### T D.1 — Shared submit helper

One function in the script block, used by all three forms:

```js
async function postInquiry(payload) { /* fetch, JSON, timeout, normalized error */ }
```

- [ ] 10s timeout via `AbortController`
- [ ] Returns a discriminated result: `{ ok: true, ref }` or `{ ok: false, error, field? }`
- [ ] Network failure produces a human message, never a raw exception string

### T D.2 — Custom-order form

Currently fakes success. Replace with the real thing.

- [ ] Four states: `idle` → `submitting` → `success` | `error`. **`sent`/`notSent` booleans are no longer sufficient** — refactor to a single `customFormState` string plus `customFormError`.
- [ ] `submitting`: button disabled, label changes, inputs disabled, spinner or pulsing dots
- [ ] `success`: keep the existing celebratory panel, add the reference number
- [ ] `error`: inline message in `#EF4056` above the button, **form values preserved**, retry possible. Losing a typed request on a failed submit is the worst outcome here — guard against it.
- [ ] Client-side validation before POST, with the invalid field focused and described via `aria-describedby`
- [ ] Hidden honeypot input named `hp`, visually hidden (not `display:none`) with `tabindex="-1"` and `autocomplete="off"`

### T D.3 — Contact section

`#contact` is currently the Instagram marquee + grid — there is **no contact form**, and the nav links to it. The tiles all link to `#contact` (i.e. themselves), which is a dead loop.

- [ ] Add a compact contact form (name, email, message) below the Instagram grid, sharing the Phase D.1 helper with `type: 'contact'`
- [ ] Point the Instagram tiles at the real profile with `target="_blank" rel="noopener noreferrer"`, or make them non-interactive `<div>`s if there is no profile URL yet. **Ask Kyle rather than guessing the handle** — `@verrecrafts` appears in the marquee but is unverified.
- [ ] Same status-state treatment as D.2

### T D.4 — Cart checkout

- [ ] "Request this order" swaps the drawer body for a short form: name, email, phone (optional), fulfillment radio (Pickup in Cebu / Cebu delivery / Ship nationwide), optional note
- [ ] Submits `type: 'order'` with `items` as `[{id, qty}]` only — **no prices from the client**
- [ ] Success: clear the cart, clear `localStorage`, show the reference number and next steps ("I'll email you within 2–3 days with the total including shipping, and payment details")
- [ ] Failure: **keep the cart intact**, show a retry
- [ ] Back button inside the form returns to the line-item view without losing entered data

**Phase D acceptance:** all three forms produce real emails; every failure mode is recoverable without data loss; no form can be double-submitted.

---

## PHASE E — Verification

Do not mark this project done until every box is ticked.

### Build & deploy
- [ ] `npm run build` clean
- [ ] `wrangler dev` — full flow works locally
- [ ] Deployed preview — full flow works with real secrets
- [ ] `dist/` is not tracked in git; no secrets in history

### Functional
- [ ] Add / increment / decrement / remove / clear cart
- [ ] Cart persists across reload; a hand-corrupted `localStorage` value does not break the page
- [ ] Sold-out product cannot be added from card *or* modal
- [ ] Deep link `?p=<slug>` opens the right modal cold
- [ ] All three forms: success path, validation failure, server-error path, offline path
- [ ] Worker rejects: bad JSON, unknown product id, `qty: 0`, `qty: 999`, 60 items, 1 MB body, missing email, `GET`
- [ ] Rate limit triggers at the 6th request and recovers

### Accessibility
- [ ] Keyboard-only: complete a purchase request and a custom order without a mouse
- [ ] Focus is trapped in each overlay and restored on close
- [ ] Screen reader announces cart changes and form results
- [ ] Both overlays close on `Escape`
- [ ] `prefers-reduced-motion: reduce` — no slide, no spin, no float

### Cross-cutting
- [ ] iOS Safari: drawer scroll lock does not cause background scroll bleed (the classic `position:fixed` body bug)
- [ ] 320px viewport: drawer and modal are usable, nothing overflows horizontally
- [ ] The sticky nav still sticks — note the existing comment on line ~49: `overflow-x:clip` is deliberate because `overflow-x:hidden` creates a scroll container and kills the sticky nav. **Do not "fix" it.**
- [ ] No console errors or warnings on load, open, add, submit
- [ ] Lighthouse a11y ≥ 95

### Review pass
- [ ] `support.js` untouched (`git diff --stat` proves it)
- [ ] No npm runtime dependencies added
- [ ] No product copy left as placeholder
- [ ] Overlay logic (focus trap, scroll lock, Esc) exists in exactly one place

---

## Out of scope — do not build

Card payments · user accounts · a real inventory backend · CMS · reviews · a newsletter · analytics · i18n · multi-page routing · the SEO/structured-data and Instagram-feed work.

Those are a later phase. Finish these three properly first.

---

## Open questions for Kyle

1. **Resend sending domain** — is `verrecrafts.ph` verified, or does the site need a different from-address for now?
2. **Notification inbox** — `hello@verrecrafts.ph`, or somewhere else?
3. **Real Instagram/Facebook URLs** — the footer and grid currently link to `#top` and `#contact`.
4. **Product details** — are the invented dimensions/materials/care values acceptable as a starting point, or should real specs be supplied before launch?
5. **Fulfillment options** — is nationwide shipping actually offered, or is it Cebu pickup and delivery only?
