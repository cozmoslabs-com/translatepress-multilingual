/**
 * Single source of truth for the locale list.
 * Loads locales.json and exposes both the ordered list of codes and a code→name map.
 */

const fs = require('fs');
const path = require('path');

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'locales.json'), 'utf8'));

const LOCALES = raw.locales.map(l => l.code);
const LOCALE_NAMES = Object.fromEntries(raw.locales.map(l => [l.code, l.name]));

module.exports = { LOCALES, LOCALE_NAMES };
