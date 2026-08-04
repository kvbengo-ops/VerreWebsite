/**
 * Seasonal themes for the storefront.
 *
 * Shared by the Worker (which resolves what is live and injects it) and the
 * admin (which lists them). One definition, one source of truth — a palette
 * that disagreed between the preview and the live site would be worse than no
 * theming at all.
 *
 * Dates are Manila-local month/day pairs, deliberately not full dates: these
 * windows repeat every year and hardcoding 2026 would quietly stop working in
 * January.
 */

export const DEFAULT_THEME = {
  id: 'default',
  label: 'Everyday',
  blurb: 'The regular Verre look. Runs whenever no season is active.',
  swatch: ['#F157A8', '#FFB6D9', '#FFD166'],
  hero: 'linear-gradient(165deg,#FFB6D9 0%,#F98AC4 45%,#F157A8 100%)',
  accent: '#F157A8',
  accentDeep: '#EF4056',
  onHero: '#fff',
  ribbon: null,
  // Four floating shapes in the hero. `kind` maps to an SVG in the storefront.
  decor: [
    { kind: 'cloud', fill: '#EAF7FF' },
    { kind: 'star', fill: '#FFD166' },
    { kind: 'heart', fill: '#EF4056' },
    { kind: 'star', fill: '#7ED3F2' }
  ]
};

/**
 * Ordered by priority, most specific first. When two windows overlap the
 * earlier entry wins — Sinulog sits inside the tail of the New Year window and
 * should beat it in Cebu.
 */
export const THEMES = [
  {
    id: 'sinulog',
    label: 'Sinulog',
    blurb: "Cebu's own. Runs through the novena and the big Sunday.",
    // The festival is the third Sunday of January; the city is dressed for most
    // of the month around it.
    from: [1, 8], to: [1, 22],
    swatch: ['#EF4056', '#FFD166', '#F5911E'],
    hero: 'linear-gradient(165deg,#FFD166 0%,#F5911E 45%,#EF4056 100%)',
    accent: '#EF4056',
    accentDeep: '#C22B3E',
    onHero: '#fff',
    ribbon: 'Pit Señor! ✦ Sinulog pieces in the shop ✦',
    decor: [
      { kind: 'sun', fill: '#FFD166' },
      { kind: 'star', fill: '#fff' },
      { kind: 'flower', fill: '#F5911E' },
      { kind: 'sun', fill: '#FFF0C7' }
    ]
  },
  {
    id: 'valentines',
    label: "Valentine's",
    blurb: 'Early February, through the fourteenth.',
    from: [2, 1], to: [2, 15],
    swatch: ['#EF4056', '#FFB6D9', '#FFF0F7'],
    hero: 'linear-gradient(165deg,#FFD9EC 0%,#FF8FB8 45%,#EF4056 100%)',
    accent: '#EF4056',
    accentDeep: '#B81E38',
    onHero: '#fff',
    ribbon: 'Handmade gifts, ready before the 14th ✦',
    decor: [
      { kind: 'heart', fill: '#fff' },
      { kind: 'heart', fill: '#FFD166' },
      { kind: 'heart', fill: '#EF4056' },
      { kind: 'star', fill: '#FFB6D9' }
    ]
  },
  {
    id: 'undas',
    label: 'Undas',
    blurb: 'Late October into All Saints. Warm and candlelit, not spooky.',
    from: [10, 24], to: [11, 3],
    swatch: ['#7A4A9E', '#F5911E', '#FFD166'],
    hero: 'linear-gradient(165deg,#F5911E 0%,#B85C9E 48%,#5B3D7A 100%)',
    accent: '#7A4A9E',
    accentDeep: '#4E2E68',
    onHero: '#fff',
    ribbon: 'Candle-warm colours all week ✦',
    decor: [
      { kind: 'candle', fill: '#FFD166' },
      { kind: 'star', fill: '#FFF0C7' },
      { kind: 'flower', fill: '#F5911E' },
      { kind: 'candle', fill: '#FFB6D9' }
    ]
  },
  {
    id: 'christmas',
    label: 'Christmas',
    // The Ber months are a real retail season here, not a joke — parols go up
    // in September and the shopping starts with them.
    blurb: 'From the first of the Ber months through Christmas Day.',
    from: [9, 1], to: [12, 26],
    swatch: ['#2C8051', '#EF4056', '#FFD166'],
    hero: 'linear-gradient(165deg,#EF4056 0%,#C42B3E 42%,#1F6B41 100%)',
    accent: '#2C8051',
    accentDeep: '#1F6B41',
    onHero: '#fff',
    ribbon: 'Christmas orders — message early, everything is made by hand ✦',
    decor: [
      { kind: 'parol', fill: '#FFD166' },
      { kind: 'star', fill: '#fff' },
      { kind: 'parol', fill: '#7ED3F2' },
      { kind: 'star', fill: '#2C8051' }
    ]
  },
  {
    id: 'newyear',
    label: 'New Year',
    // Wraps the year boundary. The resolver handles from > to.
    blurb: 'Boxing Day through the first week of January.',
    from: [12, 27], to: [1, 7],
    swatch: ['#20475C', '#FFD166', '#7ED3F2'],
    hero: 'linear-gradient(165deg,#7ED3F2 0%,#3A6E96 45%,#20475C 100%)',
    accent: '#20475C',
    accentDeep: '#13303E',
    onHero: '#fff',
    ribbon: 'New year, new little batches ✦',
    decor: [
      { kind: 'star', fill: '#FFD166' },
      { kind: 'sparkle', fill: '#fff' },
      { kind: 'star', fill: '#7ED3F2' },
      { kind: 'sparkle', fill: '#FFD166' }
    ]
  }
];

export const ALL_THEMES = [DEFAULT_THEME, ...THEMES];

export const themeById = (id) => ALL_THEMES.find((theme) => theme.id === id) || null;

/** Manila month/day for an instant, without pulling in a date library. */
export function manilaMonthDay(at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', month: '2-digit', day: '2-digit'
  }).formatToParts(at);
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  return [get('month'), get('day')];
}

const asNumber = ([month, day]) => month * 100 + day;

/**
 * True when month/day falls inside the window, inclusive at both ends.
 * A window whose start is after its end wraps the year — New Year runs
 * 27 December to 7 January, which is two ranges, not one.
 */
export function inWindow([month, day], from, to) {
  const value = asNumber([month, day]);
  const start = asNumber(from);
  const end = asNumber(to);
  return start <= end ? value >= start && value <= end : value >= start || value <= end;
}

/**
 * What should be on the storefront right now.
 *
 * `override` comes from admin and beats the calendar entirely:
 *   null / undefined / 'auto' → follow the dates
 *   'default'                 → force the everyday look, even in December
 *   any theme id              → force that theme
 * An unknown id falls back to automatic rather than erroring, so a typo or a
 * theme deleted from this file cannot take the homepage down.
 */
export function resolveTheme(override, at = new Date()) {
  if (override && override !== 'auto') {
    const forced = themeById(override);
    if (forced) return { theme: forced, source: 'override' };
    return { theme: pickByDate(at), source: 'auto', warning: 'unknown theme override: ' + override };
  }
  return { theme: pickByDate(at), source: 'auto' };
}

function pickByDate(at) {
  const today = manilaMonthDay(at);
  return THEMES.find((theme) => inWindow(today, theme.from, theme.to)) || DEFAULT_THEME;
}
