#!/usr/bin/env node
/**
 * Debug PDF Parse Import
 */

console.log('\n' + '='.repeat(80));
console.log('PDF-PARSE IMPORT DEBUG');
console.log('='.repeat(80) + '\n');

try {
  console.log('Test 1: Direct CJS require');
  const m1 = require('pdf-parse');
  console.log('  Type:', typeof m1);
  console.log('  Keys:', Object.keys(m1).slice(0, 5));
  console.log('  Is function:', typeof m1 === 'function');
} catch (e) {
  console.log('  Error (expected):', e.message);
}

try {
  console.log('\nTest 2: ES Module import');
  const m2 = await import('pdf-parse');
  console.log('  Type:', typeof m2);
  console.log('  Keys:', Object.keys(m2));
  console.log('  m2.default:', typeof m2.default);
  
  if (typeof m2.default === 'function') {
    console.log('  ✓ m2.default is a function');
  } else {
    console.log('  m2.default type:', typeof m2.default);
  }
} catch (e) {
  console.log('  Error:', e.message);
}

console.log('\n');
