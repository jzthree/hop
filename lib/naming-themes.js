'use strict';

const crypto = require('crypto');

/**
 * Naming themes for hop sessions.
 *
 * Each fixed-pool theme provides names that are sampled in random order
 * for new sessions, skipping any names already in use.
 */

const THEMES = {
  number: {
    label: 'numbers',
    example: '1, 2, 3...',
    // Generated on demand — infinite pool
    pool: null,
    generate(index) {
      return String(index + 1);
    }
  },

  alphabet: {
    label: 'alphabet',
    example: 'Kilo, Tango, Bravo...',
    pool: [
      'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot',
      'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima',
      'Mike', 'November', 'Oscar', 'Papa', 'Quebec', 'Romeo',
      'Sierra', 'Tango', 'Uniform', 'Victor', 'Whiskey', 'X-ray',
      'Yankee', 'Zulu'
    ]
  },

  greek: {
    label: 'greek',
    example: 'Sigma, Beta, Omega...',
    pool: [
      'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta',
      'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Mu',
      'Nu', 'Xi', 'Omicron', 'Pi', 'Rho', 'Sigma',
      'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega'
    ]
  },

  names: {
    label: 'names',
    example: 'Clara, Felix, Hugo...',
    pool: [
      'Ada', 'Alma', 'Arlo', 'Bea', 'Bruno', 'Cleo',
      'Clara', 'Dara', 'Eli', 'Elsa', 'Emil', 'Esme',
      'Felix', 'Flora', 'Gus', 'Hazel', 'Hugo', 'Ida',
      'Iris', 'Ivy', 'Juno', 'Kai', 'Kit', 'Leo',
      'Lily', 'Lou', 'Luna', 'Mae', 'Max', 'Mila',
      'Milo', 'Nell', 'Nico', 'Nora', 'Opal', 'Otto',
      'Pearl', 'Piper', 'Quinn', 'Rae', 'Reed', 'Rex',
      'Rosa', 'Ruby', 'Sage', 'Sam', 'Sol', 'Tara',
      'Tess', 'Theo', 'Vera', 'Wren', 'Zara', 'Zoe',
      'Alden', 'Basil', 'Caleb', 'Darcy', 'Eden', 'Freya',
      'Grant', 'Hana', 'Ivan', 'Jules', 'Kira', 'Lena',
      'Luca', 'Maren', 'Nash', 'Olive', 'Penn', 'Remy',
      'River', 'Robin', 'Rowan', 'Sasha', 'Shay', 'Skye',
      'Stella', 'Suki', 'Tai', 'Vale', 'Vivi', 'Wynn',
      'Yael', 'Zev'
    ]
  },

  pets: {
    label: 'pets',
    example: 'Mochi, Pepper, Biscuit...',
    pool: [
      'Biscuit', 'Buddy', 'Coco', 'Cookie', 'Daisy', 'Fern',
      'Ginger', 'Hazel', 'Honey', 'Jasper', 'Luna', 'Maple',
      'Mochi', 'Mocha', 'Noodle', 'Olive', 'Oreo', 'Peach',
      'Peanut', 'Pepper', 'Pickles', 'Poppy', 'Pumpkin', 'Rosie',
      'Scout', 'Shadow', 'Smoky', 'Snowy', 'Sunny', 'Toffee',
      'Truffle', 'Waffles', 'Ziggy', 'Bean', 'Bear', 'Birdie',
      'Boots', 'Brownie', 'Butterscotch', 'Caramel', 'Chai',
      'Cheddar', 'Chip', 'Clover', 'Cocoa', 'Crispy', 'Crumble',
      'Cupcake', 'Dash', 'Doodle', 'Ember', 'Fig', 'Fizz',
      'Flicker', 'Freckles', 'Gizmo', 'Jellybean', 'Kiwi',
      'Latte', 'Lemon', 'Mango', 'Marble', 'Marshmallow', 'Mint',
      'Miso', 'Mittens', 'Nugget', 'Oats', 'Pancake', 'Patches',
      'Pixel', 'Plum', 'Pretzel', 'Rascal', 'Rolo', 'Smores',
      'Sage', 'Sesame', 'Socks', 'Sorbet', 'Sprout', 'Strudel',
      'Taffy', 'Taco', 'Toast', 'Walnut', 'Whiskers', 'Willow'
    ]
  },

  astro: {
    label: 'astro',
    example: 'Orion, Vega, Nebula...',
    pool: [
      'Andromeda', 'Apollo', 'Aquila', 'Aries', 'Atlas', 'Aurora',
      'Callisto', 'Castor', 'Celeste', 'Ceres', 'Comet', 'Corona',
      'Cosmos', 'Cygnus', 'Draco', 'Eclipse', 'Europa', 'Flare',
      'Galaxy', 'Gemini', 'Halley', 'Hydra', 'Io', 'Juno',
      'Jupiter', 'Leo', 'Luna', 'Lyra', 'Mars', 'Mercury',
      'Meteor', 'Nebula', 'Neptune', 'Nova', 'Oberon', 'Orbit',
      'Orion', 'Pallas', 'Perseus', 'Phoenix', 'Pluto', 'Polaris',
      'Pulsar', 'Quasar', 'Rigel', 'Saturn', 'Sirius', 'Sol',
      'Solstice', 'Stella', 'Titan', 'Triton', 'Vega', 'Venus',
      'Vesta', 'Zenith', 'Zodiac', 'Altair', 'Antares', 'Astra',
      'Bellatrix', 'Canopus', 'Cassini', 'Centauri', 'Deneb',
      'Equinox', 'Helix', 'Hubble', 'Kepler', 'Lunar', 'Lyric',
      'Meridian', 'Mira', 'Nadir', 'Nimbus', 'Parallax', 'Proxima',
      'Sagan', 'Spica', 'Sputnik', 'Supernova', 'Umbra', 'Voyager'
    ]
  }
};

const THEME_IDS = Object.keys(THEMES);
const DEFAULT_THEME = 'names';

function shuffled(values) {
  const out = values.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * Generate the next session name for a given theme.
 *
 * @param {string} theme - Theme ID (number, alphabet, greek, names, pets, astro)
 * @param {Set<string>|string[]} existingNames - Names already in use (case-insensitive match)
 * @returns {string} A unique session name
 */
function generateSessionName(theme, existingNames) {
  const themeObj = THEMES[theme];
  if (!themeObj) {
    return generateSessionName(DEFAULT_THEME, existingNames);
  }

  const usedLower = new Set();
  const existing = existingNames instanceof Set ? existingNames : (existingNames || []);
  for (const n of existing) {
    if (typeof n === 'string') usedLower.add(n.toLowerCase());
  }

  // For themes with a fixed pool
  if (themeObj.pool) {
    for (const name of shuffled(themeObj.pool)) {
      if (!usedLower.has(name.toLowerCase())) {
        return name;
      }
    }

    // Pool exhausted — append number suffix, preserving random pool order
    for (let counter = 2; counter < 10000; counter++) {
      for (const name of shuffled(themeObj.pool)) {
        const candidate = `${name}-${counter}`;
        if (!usedLower.has(candidate.toLowerCase())) {
          return candidate;
        }
      }
    }
    // Shouldn't get here, but safety
    return `session-${Date.now().toString(36)}`;
  }

  // For generative themes (number)
  if (typeof themeObj.generate === 'function') {
    for (let i = 0; i < 10000; i++) {
      const name = themeObj.generate(i);
      if (!usedLower.has(name.toLowerCase())) {
        return name;
      }
    }
    return `session-${Date.now().toString(36)}`;
  }

  return `session-${Date.now().toString(36)}`;
}

/**
 * Get display info for all themes (for the selection prompt).
 * @returns {Array<{id: string, label: string, example: string}>}
 */
function getThemeChoices() {
  return THEME_IDS.map((id) => ({
    id,
    label: THEMES[id].label,
    example: THEMES[id].example
  }));
}

/**
 * Check if a theme ID is valid.
 * @param {string} theme
 * @returns {boolean}
 */
function isValidTheme(theme) {
  return typeof theme === 'string' && THEMES.hasOwnProperty(theme);
}

module.exports = {
  THEMES,
  THEME_IDS,
  DEFAULT_THEME,
  generateSessionName,
  getThemeChoices,
  isValidTheme
};
