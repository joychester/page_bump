// content.js — Speed Bump
// This file is NOT auto-injected via manifest content_scripts.
// Performance data is collected by background.js via chrome.scripting.executeScript
// with world: 'MAIN', using an inline function. This file serves as documentation
// of that collection logic and can be used as a named file target in the future.

// Collected via executeScript inline func in background.js:
//   performance.getEntriesByType('resource').map(e => ({
//     name: e.name,
//     encodedBodySize: e.encodedBodySize,   // compressed body bytes
//     decodedBodySize: e.decodedBodySize,   // uncompressed body bytes
//     transferSize: e.transferSize,         // total bytes over wire (0 if CORS-restricted)
//   }))
