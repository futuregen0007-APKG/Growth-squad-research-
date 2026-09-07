#!/usr/bin/env node
/**
 * Find correct PDF-Parse export
 */

console.log('Finding correct pdf-parse export...\n');

const m = await import('pdf-parse');

// Check PDFParse
if (m.PDFParse) {
  console.log('✓ PDFParse found');
  console.log('  Type:', typeof m.PDFParse);
  console.log('  Is function:', typeof m.PDFParse === 'function');
}

// Test with simple PDF buffer
const simplePdf = Buffer.from('%PDF-1.4\n%test\n');

if (typeof m.PDFParse === 'function') {
  try {
    console.log('\nTesting with simple PDF buffer...');
    const result = await m.PDFParse(simplePdf);
    console.log('  Result:', result);
  } catch (e) {
    console.log('  Error (expected for invalid PDF):', e.message.substring(0, 50));
  }
}

// Check if there's a default export in package.json
console.log('\nChecking package.json exports...');
const pkg = JSON.parse(await import('fs').then(fs => fs.promises.readFile('./node_modules/pdf-parse/package.json', 'utf8')));
console.log('  Main:', pkg.main);
console.log('  Export types:', typeof pkg.exports);

console.log('\n');
