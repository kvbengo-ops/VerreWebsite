import assert from 'node:assert/strict';
import { THEMES, ALL_THEMES, DEFAULT_THEME, resolveTheme, inWindow, manilaMonthDay, themeById } from './themes.js';

// Manila is UTC+8, so an instant late in a UTC day is already tomorrow there.
// Every window is evaluated in Manila time — the alternative is Christmas
// arriving eight hours late for everyone actually in Cebu.
const at = (iso) => new Date(iso);
const active = (iso) => resolveTheme(null, at(iso)).theme.id;

assert.deepEqual(manilaMonthDay(at('2026-12-24T20:00:00Z')), [12, 25], 'late UTC is already the next day in Manila');
assert.deepEqual(manilaMonthDay(at('2026-06-15T00:00:00Z')), [6, 15]);

/* ------------------------------------------------------------------ */
/* windows                                                             */
/* ------------------------------------------------------------------ */

assert.equal(inWindow([2, 1], [2, 1], [2, 15]), true, 'inclusive at the start');
assert.equal(inWindow([2, 15], [2, 1], [2, 15]), true, 'inclusive at the end');
assert.equal(inWindow([1, 31], [2, 1], [2, 15]), false);
assert.equal(inWindow([2, 16], [2, 1], [2, 15]), false);

// New Year runs 27 Dec – 7 Jan. A naive start<=x<=end test says that window is
// empty, which would silently mean the theme never ran.
assert.equal(inWindow([12, 31], [12, 27], [1, 7]), true, 'year-wrapping window covers December');
assert.equal(inWindow([1, 3], [12, 27], [1, 7]), true, 'year-wrapping window covers January');
assert.equal(inWindow([6, 1], [12, 27], [1, 7]), false, 'year-wrapping window excludes the middle of the year');

/* ------------------------------------------------------------------ */
/* the calendar                                                        */
/* ------------------------------------------------------------------ */

assert.equal(active('2026-03-20T04:00:00Z'), 'default', 'an ordinary March day is undressed');
assert.equal(active('2026-02-10T04:00:00Z'), 'valentines');
assert.equal(active('2026-10-28T04:00:00Z'), 'undas');
assert.equal(active('2026-09-02T04:00:00Z'), 'christmas', 'the Ber months start the Christmas season');
assert.equal(active('2026-12-20T04:00:00Z'), 'christmas');
assert.equal(active('2026-12-30T04:00:00Z'), 'newyear');
assert.equal(active('2027-01-03T04:00:00Z'), 'newyear', 'and continues across the year boundary');

// Sinulog sits inside the tail of the New Year window on purpose. Order in the
// table is the tie-break, and in Cebu the festival has to win.
assert.equal(active('2027-01-15T04:00:00Z'), 'sinulog', 'Sinulog beats New Year in mid-January');
assert.ok(
  THEMES.findIndex((t) => t.id === 'sinulog') < THEMES.findIndex((t) => t.id === 'newyear'),
  'Sinulog must be listed before New Year or the overlap resolves the wrong way'
);

/* ------------------------------------------------------------------ */
/* overrides                                                           */
/* ------------------------------------------------------------------ */

assert.equal(resolveTheme('sinulog', at('2026-06-01T04:00:00Z')).theme.id, 'sinulog', 'an override ignores the calendar');
assert.equal(resolveTheme('sinulog', at('2026-06-01T04:00:00Z')).source, 'override');
assert.equal(resolveTheme('auto', at('2026-02-10T04:00:00Z')).theme.id, 'valentines', "'auto' means follow the dates");
assert.equal(resolveTheme(null, at('2026-02-10T04:00:00Z')).theme.id, 'valentines');
assert.equal(resolveTheme('default', at('2026-12-20T04:00:00Z')).theme.id, 'default',
  "'default' forces the everyday look even in December");

// A typo, or a theme deleted from the file while still stored in the database,
// must not take the homepage down over a decoration.
const unknown = resolveTheme('easter-2019', at('2026-02-10T04:00:00Z'));
assert.equal(unknown.theme.id, 'valentines', 'an unknown override falls back to the calendar');
assert.equal(unknown.source, 'auto');
assert.ok(unknown.warning, 'and says so in the logs');

/* ------------------------------------------------------------------ */
/* shape                                                               */
/* ------------------------------------------------------------------ */

assert.equal(ALL_THEMES.length, 6, 'five seasons plus the everyday look');
assert.equal(new Set(ALL_THEMES.map((t) => t.id)).size, ALL_THEMES.length, 'theme ids must be unique');
for (const theme of ALL_THEMES) {
  for (const key of ['label', 'hero', 'accent', 'accentDeep', 'onHero', 'swatch', 'decor']) {
    assert.ok(theme[key], theme.id + ' is missing ' + key);
  }
  assert.equal(theme.decor.length, 4, theme.id + ' needs exactly four hero shapes');
  assert.ok(theme.swatch.length >= 3, theme.id + ' needs a three-colour swatch for the admin card');
  assert.equal(themeById(theme.id), theme);
}
assert.equal(themeById('nope'), null);
assert.equal(DEFAULT_THEME.ribbon, null, 'the everyday look must not show a banner');

console.log('ok — theme windows, year wrap, overlap order, overrides, and shape');
