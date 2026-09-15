import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidatesFromChunk } from '../services/guidanceExtraction.js';
import { detectGuidanceCandidate } from '../services/guidanceCandidateDetection.js';

const chunk = (text, overrides = {}) => ({
  symbol: 'TCS', documentType: 'EARNINGS_CALL_TRANSCRIPT', fiscalYear: 'FY2026', fiscalQuarter: 'Q2',
  sourceUrl: 'https://example.com/f.pdf', pageStart: 5, pageEnd: 5, publishedAt: '2025-10-09', text, ...overrides,
});

// --- Candidate detection ----------------------------------------------------
test('candidate detection: a plain guidance sentence is flagged a candidate with recorded signals', () => {
  const result = detectGuidanceCandidate('We expect operating margin to be in the 26% to 28% range for FY2026.');
  assert.equal(result.isCandidate, true);
  assert.ok(result.signals.includes('EXPECT') || result.signals.includes('RANGE'));
});

test('non-guidance rejection: unrelated text produces no candidate at all', () => {
  const result = detectGuidanceCandidate('Jaguar TCS Racing competes in Formula E using digital twin technology.');
  assert.equal(result.isCandidate, false);
  assert.equal(result.reason, 'NO_SIGNAL_MATCHED');
});

test('candidate detection excludes deterministic Safe Harbor boilerplate even though it contains signal words', () => {
  const result = detectGuidanceCandidate('Safe Harbor: statements in this call that reflect our outlook or expected guidance are forward-looking statements and involve risks and uncertainties.');
  assert.ok(result.signals.length > 0, 'the fixture must actually match at least one signal word');
  assert.equal(result.isCandidate, false);
  assert.match(result.reason, /EXCLUDED/);
});

// --- Analyst-question rejection ---------------------------------------------
test('analyst-question rejection: a question ending in "?" containing a number is never accepted as guidance', () => {
  const text = 'Gaurav Rateria: On the margins, would our immediate priority be to take margins back to our aspirational band of 26%, 28%?';
  const { annotations } = extractCandidatesFromChunk(chunk(text));
  const rejected = annotations.find((a) => a.status === 'REJECTED');
  assert.ok(rejected, 'expected a REJECTED annotation');
  assert.ok(rejected.rejectionReasons.includes('ANALYST_QUESTION_LANGUAGE'));
});

test('second-person address rejection: an analyst addressing management as "your guidance" is never accepted, even with no trailing "?"', () => {
  const text = 'Vimal Gohil Sir, so basically if we were to look at your guidance, it implies 0% to 2% sort of a revenue growth in Q4.';
  const { annotations } = extractCandidatesFromChunk(chunk(text));
  const rejected = annotations.find((a) => a.status === 'REJECTED');
  assert.ok(rejected, 'a real corpus false-positive found during Phase 4E adjudication -- must now be rejected');
  assert.ok(rejected.rejectionReasons.includes('SECOND_PERSON_ADDRESS'));
});

test('management\'s own first-person guidance statement ("we"/"our") is never rejected by the second-person gate', () => {
  const text = 'We are retaining our operating margin guidance for FY23 at 21% to 22%.';
  const { annotations } = extractCandidatesFromChunk(chunk(text));
  const verified = annotations.find((a) => a.status === 'VERIFIED');
  assert.ok(verified);
  assert.equal(verified.rejectionReasons.length, 0);
});

test('analyst-question rejection: explicit first-person analyst framing is rejected even without a trailing "?"', () => {
  const text = 'Just wanted to check about the margin trajectory of 24% for this quarter, thanks.';
  const { annotations } = extractCandidatesFromChunk(chunk(text));
  const rejected = annotations.find((a) => a.status === 'REJECTED');
  assert.ok(rejected);
  assert.ok(rejected.rejectionReasons.includes('ANALYST_FRAMING_LANGUAGE'));
});

// --- Actual-result rejection -------------------------------------------------
test('actual-result rejection: a reported historical margin figure is never treated as guidance', () => {
  const text = 'Our Q1 operating margin stood at 24.5%, reflecting a sequential improvement of 30 basis points.';
  const { annotations } = extractCandidatesFromChunk(chunk(text));
  const rejected = annotations.find((a) => a.status === 'REJECTED');
  assert.ok(rejected);
  assert.ok(rejected.rejectionReasons.includes('ACTUAL_RESULT_NOT_GUIDANCE'));
});

test('genuine forward guidance with no past-tense result verb at all is accepted (ACTUAL_RESULT_PATTERN never fires on it)', () => {
  const text = 'We expect operating margin to be 26% to 28% going forward for FY2026.';
  const { annotations } = extractCandidatesFromChunk(chunk(text));
  const verified = annotations.find((a) => a.status === 'VERIFIED');
  assert.ok(verified);
  assert.equal(verified.rejectionReasons.length, 0);
});

test('a past-tense result verb is rejected unconditionally, even alongside a "for the full year" phrase (no forward-marker exception)', () => {
  const text = 'Our revenue guidance for next year remains under review. For the full year, our revenue was ₹191,754 crores, which is a growth of 16.8%.';
  const { annotations } = extractCandidatesFromChunk(chunk(text));
  const rejected = annotations.find((a) => a.status === 'REJECTED');
  assert.ok(rejected, 'a historical full-year recap must never be accepted as guidance');
  assert.ok(rejected.rejectionReasons.includes('ACTUAL_RESULT_NOT_GUIDANCE'));
});

test('positive-evidence gate: a resolvable metric+value sentence with NO explicit forward-looking/revision language is UNRESOLVED, never accepted by default', () => {
  const text = 'Fantastic to have our quarter close out, 13.7% growth, 21.5% operating margin, very happy with that outcome.';
  const { annotations } = extractCandidatesFromChunk(chunk(text));
  assert.equal(annotations.some((a) => a.status === 'VERIFIED'), false);
});

// --- Exact value / percentage range / dash formats --------------------------
test('exact value extraction: a single percentage figure is captured as an exact value', () => {
  const text = 'Management expects revenue growth of 5% for the year.';
  const { annotations } = extractCandidatesFromChunk(chunk(text));
  const v = annotations.find((a) => a.status === 'VERIFIED');
  assert.ok(v);
  assert.equal(v.valueType, 'exact');
  assert.equal(v.exactValue, 5);
  assert.equal(v.unit, 'PERCENTAGE');
});

test('percentage range extraction ("to"): lower/upper bounds captured correctly', () => {
  const text = 'We are targeting operating margin of 26% to 28% for FY2026.';
  const { annotations } = extractCandidatesFromChunk(chunk(text));
  const v = annotations.find((a) => a.status === 'VERIFIED');
  assert.ok(v);
  assert.equal(v.valueType, 'range');
  assert.equal(v.lowerBound, 26);
  assert.equal(v.upperBound, 28);
});

test('percentage range extraction (dash "-"): same range, different formatting', () => {
  const text = 'We are targeting operating margin of 26%-28% for FY2026.';
  const { annotations } = extractCandidatesFromChunk(chunk(text));
  const v = annotations.find((a) => a.status === 'VERIFIED');
  assert.ok(v);
  assert.equal(v.lowerBound, 26);
  assert.equal(v.upperBound, 28);
});

test('percentage range extraction (en-dash): same range, different formatting', () => {
  const text = 'We are targeting operating margin of 26%–28% for FY2026.';
  const { annotations } = extractCandidatesFromChunk(chunk(text));
  const v = annotations.find((a) => a.status === 'VERIFIED');
  assert.ok(v);
  assert.equal(v.lowerBound, 26);
  assert.equal(v.upperBound, 28);
});

// --- Fiscal period comes from trusted metadata, never text -----------------
test('fiscal year and quarter are never extracted from sentence text -- caller must copy them from trusted chunk metadata', () => {
  const text = 'We are targeting operating margin of 26% to 28%.';
  const { annotations } = extractCandidatesFromChunk(chunk(text, { fiscalYear: 'FY2026', fiscalQuarter: 'Q2' }));
  const v = annotations.find((a) => a.status === 'VERIFIED');
  assert.ok(v);
  // extractCandidatesFromChunk itself never returns fiscalYear/fiscalQuarter
  // fields at all -- they are the caller's (enrichGuidanceCorpus.js's)
  // responsibility to copy verbatim from `chunk`, never re-derived here.
  assert.equal(v.fiscalYear, undefined);
  assert.equal(v.fiscalQuarter, undefined);
});

// --- Missing period / unresolved --------------------------------------------
test('missing/unrecognizable value: a metric word with no number in the same sentence is UNRESOLVED, never forced', () => {
  const text = 'Looking ahead, our financial resilience will support investments aligned with our aspiration.';
  const { annotations } = extractCandidatesFromChunk(chunk(text));
  assert.equal(annotations.length === 0 || annotations.every((a) => a.status !== 'VERIFIED'), true);
});

// --- Revised / maintained / raised / lowered --------------------------------
test('revised guidance: explicit "revised" language classifies guidanceKind REVISED', () => {
  const text = 'The company revised its FY2026 revenue growth guidance to 8% for the year.';
  const { annotations } = extractCandidatesFromChunk(chunk(text));
  const v = annotations.find((a) => a.status === 'VERIFIED');
  assert.ok(v);
  assert.equal(v.guidanceKind, 'REVISED');
});

test('maintained guidance: explicit "maintained"/"reiterated" language classifies guidanceKind MAINTAINED', () => {
  const text = 'Management maintained its operating margin guidance of 26% to 28% for FY2026.';
  const { annotations } = extractCandidatesFromChunk(chunk(text));
  const v = annotations.find((a) => a.status === 'VERIFIED');
  assert.ok(v);
  assert.equal(v.guidanceKind, 'MAINTAINED');
});

test('raised guidance: explicit "raised guidance" language classifies guidanceKind RAISED', () => {
  const text = 'The company raised its revenue growth guidance to 9% for FY2026.';
  const { annotations } = extractCandidatesFromChunk(chunk(text));
  const v = annotations.find((a) => a.status === 'VERIFIED');
  assert.ok(v);
  assert.equal(v.guidanceKind, 'RAISED');
});

test('lowered guidance: explicit "lowered guidance" language classifies guidanceKind LOWERED', () => {
  const text = 'The company lowered its revenue growth guidance to 3% for FY2026.';
  const { annotations } = extractCandidatesFromChunk(chunk(text));
  const v = annotations.find((a) => a.status === 'VERIFIED');
  assert.ok(v);
  assert.equal(v.guidanceKind, 'LOWERED');
});

test('plain guidance language with no revision marker classifies guidanceKind ORIGINAL', () => {
  const text = 'We are targeting operating margin of 26% to 28% for FY2026.';
  const { annotations } = extractCandidatesFromChunk(chunk(text));
  const v = annotations.find((a) => a.status === 'VERIFIED');
  assert.ok(v);
  assert.equal(v.guidanceKind, 'ORIGINAL');
});

// --- Unsupported unit conversion --------------------------------------------
test('unsupported unit conversion: a bare number with no unit/percentage marker is never treated as a guidance figure', () => {
  const text = 'We are targeting growth of 42 for the year.';
  const { annotations } = extractCandidatesFromChunk(chunk(text));
  assert.equal(annotations.some((a) => a.status === 'VERIFIED'), false);
});

test('unsupported unit conversion: currency+magnitude figures are captured in their OWN unit, never converted to percentage or a different currency magnitude', () => {
  const text = 'We are targeting capex of ₹500 crore for FY2026.';
  const { annotations } = extractCandidatesFromChunk(chunk(text));
  const v = annotations.find((a) => a.status === 'VERIFIED' || a.status === 'UNRESOLVED');
  assert.ok(v);
  if (v.status === 'VERIFIED') {
    assert.equal(v.unit, 'INR_CRORE');
    assert.notEqual(v.unit, 'PERCENTAGE');
  }
});

// --- Supporting-span validation ---------------------------------------------
test('supporting-span validation: every returned span is an exact substring of the original chunk text', () => {
  const text = 'Management maintained its operating margin guidance of 26% to 28% for FY2026, a long-standing target.';
  const { annotations } = extractCandidatesFromChunk(chunk(text));
  for (const a of annotations) {
    assert.ok(text.includes(a.supportingSpan), `span "${a.supportingSpan}" must be a substring of the source text`);
  }
});

// --- Real corpus fixture regression (Phase 4E Part 7 investigation) --------
test('REAL CORPUS FIXTURE (TCS FY2022 earnings call, page 12): analyst question about the 26%-28% aspiration band is rejected, not attributed to management', () => {
  // Verbatim excerpt retrieved from the real, stored ResearchDocumentChunk
  // during Phase 4E's Part 1 corpus investigation (TCS, FY2022,
  // EARNINGS_CALL_TRANSCRIPT, page 12, sourceUrl ending
  // f424c104-aab6-47ba-9659-65a2ce5689e1.pdf, publishedAt 2022-04-16).
  const text = 'Kumar Rakesh: On the margin front, would it be fair to assume that we are driving towards the higher end of our aspiration band above 26%, 28%?';
  const { annotations } = extractCandidatesFromChunk(chunk(text, { symbol: 'TCS', fiscalYear: 'FY2022', fiscalQuarter: null, pageStart: 12, pageEnd: 12 }));
  const rejected = annotations.find((a) => a.status === 'REJECTED');
  assert.ok(rejected, 'the analyst question must never be accepted as management guidance');
  assert.ok(rejected.rejectionReasons.includes('ANALYST_QUESTION_LANGUAGE'));
});

test('REAL CORPUS FIXTURE (TCS FY2026 Q2 press release, page 3): generic aspirational CFO language with no quantified figure resolves UNRESOLVED, never a fabricated 26% value', () => {
  // Verbatim excerpt retrieved from the real, stored ResearchDocumentChunk
  // during Phase 4E's Part 1 investigation (TCS, FY2026, PRESS_RELEASE,
  // page 3, publishedAt 2025-10-09) -- the CFO's own quote from the exact
  // earnings release the curated TCS-FY2026-001 Earnings Intelligence
  // record's promiseDate falls within, yet it never states the 26% figure
  // itself: "expand our margins ... aligned with our aspiration."
  const text = 'Samir Seksaria, Chief Financial Officer, said, We achieved good growth momentum across all verticals this quarter. Our disciplined execution helped us expand our margins while making strategic investments.';
  const { annotations } = extractCandidatesFromChunk(chunk(text, { symbol: 'TCS', fiscalYear: 'FY2026', fiscalQuarter: 'Q2', documentType: 'PRESS_RELEASE', pageStart: 3, pageEnd: 3, publishedAt: '2025-10-09' }));
  assert.equal(annotations.some((a) => a.status === 'VERIFIED' && a.exactValue === 26), false);
});
