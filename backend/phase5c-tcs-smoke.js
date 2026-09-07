#!/usr/bin/env node
import assert from 'node:assert/strict';
import { collectDocuments } from './research/DocumentResearchService.js';
import { extractPromisesFromDocument } from './services/PromiseExtractionService.js';

const result = await collectDocuments('TCS');
const candidates = result.documents.filter((document) => (
  document.extractionStatus === 'SUCCESS'
  && document.sourceTrust?.trustLevel === 'OFFICIAL'
  && /\.pdf(?:$|[?#])/i.test(document.url || document.sourceUrl || '')
  && /q1|fy27|earnings|transcript|concall/i.test(`${document.title} ${document.url}`)
));

const extracted = candidates.flatMap((document) => extractPromisesFromDocument(document));
const employeePromises = extracted.filter((promise) => (
  promise.metric === 'EMPLOYEE_PERCENTAGE' && promise.targetValue === 1
));

assert.ok(candidates.length > 0, 'No official TCS Q1 FY27 PDF was collected');
assert.ok(employeePromises.some((promise) => promise.evidence.page === 13), 'TCS 1% employee promise was not found on page 13');
assert.ok(employeePromises.every((promise) => promise.period === 'GOING_FORWARD'), 'Employee promise contains a fabricated deadline');

console.log(JSON.stringify({
  documents: candidates.length,
  promises: employeePromises,
  mongoWrites: 0
}, null, 2));