// Everything that depends on Audible's web player page lives here, so a change on Audible's side
// is a one-file fix. Each entry is a list of CSS selectors tried in order; the first one that
// matches a visible element wins.
//
// Checked against the live player (Oct 2026). If Audible changes it, open a book in the player
// and run  node server/dump-player.js  to see what's there now.
module.exports = {
  // Which open tab is the player. Audible opens it in its own window/tab.
  playerUrl: /audible\.[a-z.]+\/webplayer/i,
  // Any tab on Audible's site (used to read the library when no player is open).
  audibleUrl: /^https:\/\/www\.audible\.[a-z.]+\//i,

  // The library page (/library/titles): one row per book, its id ending in the book's ASIN.
  library: {
    row: '[id^="adbl-library-content-row-"]',
    rowIdPrefix: 'adbl-library-content-row-',
    title: '.bc-size-headline3',
    author: '.authorLabel a',
  },

  // Audible's controls are web components; the aria-labels sit on adbl-icon elements inside their
  // shadow DOM. Playwright's CSS selectors look inside open shadow roots, and a click on the icon
  // reaches its button.
  playPause: [
    'adbl-icon[aria-label="Pause"]',
    'adbl-icon[aria-label="Play"]',
    '[aria-label="Pause"]',
    '[aria-label="Play"]',
  ],
  back30: [
    'adbl-icon[aria-label="Skip back 30 seconds"]',
    '[data-testid="skip-back"]',
    '[aria-label*="back 30" i]',
  ],
  forward30: [
    'adbl-icon[aria-label="Skip forward 30 seconds"]',
    '[data-testid="skip-forward"]',
    '[aria-label*="forward 30" i]',
  ],
  // "Another device is active" dialog (the Audible app took over): pressed before play.
  takeOver: [
    'adbl-button[data-testid="device-conflict-listen"]',
  ],

  // Read-only status text. Shadow DOM is searched too. When nothing matches, status falls back
  // to the page's media element for position/duration.
  title: ['h2[data-testid="title"]'],
  chapter: ['[data-testid="current-section-title"]'],
  // Position in the current chapter, e.g. "29:14".
  elapsed: ['[data-testid="time-current"]', '[class*="_leftTime_"]'],
  // Time left in the current chapter, e.g. "-4:09".
  remaining: ['[data-testid="time-remaining-section"]', '[class*="_rightTime_"]'],
  // Time left in the whole book, e.g. "32h 13m left".
  bookLeft: ['[data-testid="time-remaining-book"]', '[class*="_centerTime_"]'],
};
