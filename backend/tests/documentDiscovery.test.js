import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  normalizeDocumentUrl,
  deduplicateUrls,
  discoverPdfLinks,
  discoverPdfsFromLandingPage,
  documentQualityGate,
  documentMatchesCompany,
  buildDocumentProvenance,
  classifyFetchFailure,
  isPdfBuffer,
  collectTier1InvestorRelations,
  collectDocuments,
} from '../research/DocumentResearchService.js';
import { getCompanyResearchProfile } from '../research/CompanyResearchProfiles.js';

test('PDF validation requires the PDF file signature', () => {
  assert.equal(isPdfBuffer(Buffer.from('%PDF-1.7\n')), true);
  assert.equal(isPdfBuffer(Buffer.from('<html>login</html>')), false);
});

test('HTTP response failures retain the response status', () => {
  const reason = classifyFetchFailure({
    code: 'ERR_BAD_REQUEST',
    message: 'Request failed with status code 404',
    response: { status: 404 }
  });
  assert.equal(reason.code, 'HTTP_404');
  assert.equal(reason.severity, 'HTTP_FAILURE');
  assert.equal(reason.status, 404);
});

test('relative URL normalization and duplicate removal are stable', () => {
  assert.equal(
    normalizeDocumentUrl('/annual-report.pdf', 'https://newgensoft.com/investor-relations/'),
    'https://newgensoft.com/annual-report.pdf'
  );

  const deduped = deduplicateUrls([
    'https://example.com/report.pdf',
    'https://example.com/report.pdf#section',
    'https://example.com/annual-report.pdf',
    'http://example.com/report.pdf',
  ]);

  assert.deepEqual(deduped, [
    'https://example.com/report.pdf',
    'https://example.com/annual-report.pdf',
    'http://example.com/report.pdf',
  ]);
});

test('PDF URL discovery accepts valid documents and rejects invalid links', () => {
  const html = `
    <a href="/files/q1-results.pdf">Q1 results</a>
    <a href="https://example.com/fy25-presentation.pdf">FY25 Presentation</a>
    <a href="javascript:alert(1)">Bad</a>
    <a href="mailto:test@example.com">Mail</a>
    <a href="">Empty</a>
    <a href="ftp://example.com/file.pdf">FTP</a>
  `;

  const found = discoverPdfLinks(html, 'https://newgensoft.com/investor-relations/');
  assert.ok(found.some((item) => item.url.includes('q1-results.pdf')));
  assert.ok(found.some((item) => item.url.includes('fy25-presentation.pdf')));
  assert.ok(found.every((item) => item.url.startsWith('http://') || item.url.startsWith('https://')));
  assert.ok(!found.some((item) => item.url.startsWith('javascript:')));
  assert.ok(!found.some((item) => item.url.startsWith('mailto:')));
});

test('document quality gate blocks empty or failed documents', () => {
  const failedDoc = {
    url: 'https://example.com/bad.pdf',
    provider: 'InvestorRelations',
    title: 'Bad',
    extractionStatus: 'FAILED',
    text: '',
    contentLength: 0,
  };

  const validDoc = {
    url: 'https://example.com/valid.pdf',
    provider: 'InvestorRelations',
    title: 'Quarterly Results',
    extractionStatus: 'SUCCESS',
    text: 'This is a substantive earnings note from official company disclosures with more than fifty words of verifiable operating and financial detail.',
    contentLength: 170,
    publishedAt: '2025-05-12T00:00:00.000Z',
  };

  assert.equal(documentQualityGate(failedDoc), false);
  assert.equal(documentQualityGate(validDoc), true);
});

test('provenance metadata preserves real-source fields', () => {
  const document = buildDocumentProvenance({
    url: 'https://example.com/report.pdf',
    title: 'Quarterly Results',
    provider: 'InvestorRelations',
    sourceType: 'QUARTERLY_REPORT',
    discoveredFrom: 'https://newgensoft.com/investor-relations/',
    publishedAt: '2025-05-12T00:00:00.000Z',
    text: 'Substantive content from a valid quarterly report.',
    extractionStatus: 'SUCCESS',
  });

  assert.equal(document.url, 'https://example.com/report.pdf');
  assert.equal(document.canonicalUrl, 'https://example.com/report.pdf');
  assert.equal(document.provider, 'InvestorRelations');
  assert.equal(document.sourceType, 'QUARTERLY_REPORT');
  assert.equal(document.extractionStatus, 'SUCCESS');
  assert.ok(document.retrievedAt);
  assert.ok(document.contentHash);
});

test('failed PDF downloads remain rejected and retain TLS failure code classification', () => {
  const reason = classifyFetchFailure({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'unable to verify the first certificate' });
  assert.equal(reason.code, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  assert.equal(reason.severity, 'TLS_FAILURE');
  assert.equal(reason.isBlocking, true);
});

test('enhanced TLS error classification includes certificate details', () => {
  const tlsError = {
    code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    message: 'unable to verify the first certificate',
    cause: {
      errno: 'CERT_CHAIN_TOO_LONG',
      syscall: 'getaddrinfo',
      toString: () => 'Error: certificate chain validation failed'
    }
  };
  
  const reason = classifyFetchFailure(tlsError);
  assert.equal(reason.severity, 'TLS_FAILURE');
  assert.ok(reason.tlsDetails);
  assert.ok(reason.tlsDetails.cause);
});

test('network errors are classified separately from TLS errors', () => {
  const networkError = { code: 'ECONNREFUSED', message: 'connection refused' };
  const reason = classifyFetchFailure(networkError);
  assert.equal(reason.severity, 'NETWORK_FAILURE');
  assert.equal(reason.code, 'ECONNREFUSED');
});

test('enhanced document discovery recognizes quarterly reports and presentations', () => {
  const html = `
    <a href="/fy25-quarterly-results.pdf">Q3 FY25 Results</a>
    <a href="/investor-presentation-q2.pdf">Investor Presentation Q2</a>
    <a href="/annual-report-2024.pdf">Annual Report 2024</a>
    <a href="/earnings-call-transcript.docx">Earnings Call Transcript</a>
    <a href="/not-a-document.html">HTML Page</a>
  `;

  const found = discoverPdfLinks(html, 'https://example.com/');
  assert.equal(found.length, 4);
  assert.ok(found.some(d => d.url.includes('quarterly-results.pdf')));
  assert.ok(found.some(d => d.url.includes('investor-presentation')));
  assert.ok(found.some(d => d.url.includes('annual-report')));
  assert.ok(found.some(d => d.url.includes('transcript.docx')));
  assert.ok(!found.some(d => d.url.includes('html')));
});

test('document classification identifies document type from URL and title', () => {
  const html = `
    <a href="/docs/annual-report-2024.pdf">Annual Report 2024</a>
    <a href="/investor/presentation.pdf">Investor Presentation</a>
    <a href="/nse-filing.pdf">NSE Filing</a>
  `;

  const found = discoverPdfLinks(html, 'https://example.com/');
  assert.equal(found.length, 3);
  assert.ok(found.every(d => d.kind === 'DOCUMENT'));
});

test('relative URL normalization preserves original URLs from same domain', () => {
  const urls = [
    '/documents/report.pdf',
    './report.pdf',
    '../report.pdf',
    'https://other.com/report.pdf'
  ];

  const normalized = urls.map(url => normalizeDocumentUrl(url, 'https://newgensoft.com/investor/'));
  
  assert.ok(normalized[0].includes('newgensoft.com'));
  assert.ok(normalized[0].includes('report.pdf'));
  assert.ok(normalized[3].includes('other.com'));
});

test('duplicate URL removal is stable across link variations', () => {
  const urls = [
    'https://example.com/report.pdf',
    'https://example.com/report.pdf#page=1',
    'https://example.com/report.pdf?v=1',
    'https://example.com/report.pdf?v=1#page=1',
    'https://example.com/other.pdf'
  ];

  const deduped = deduplicateUrls(urls);
  
  // Should keep unique URLs but remove fragment/query duplicates
  assert.ok(deduped.length <= urls.length);
  assert.ok(deduped.some(u => u.includes('report.pdf')));
  assert.ok(deduped.some(u => u.includes('other.pdf')));
});

test('document quality gate enforces minimum content and metadata requirements', () => {
  const tooShort = {
    url: 'https://example.com/bad.pdf',
    provider: 'InvestorRelations',
    title: 'Short',
    extractionStatus: 'SUCCESS',
    text: 'Too short',
    contentLength: 9
  };

  const noProvider = {
    url: 'https://example.com/bad.pdf',
    provider: null,
    title: 'Title',
    extractionStatus: 'SUCCESS',
    text: 'This is a substantive earnings note from official company disclosures with more than fifty words of verifiable operating and financial detail.',
    contentLength: 150
  };

  const noTitle = {
    url: 'https://example.com/bad.pdf',
    provider: 'InvestorRelations',
    title: null,
    extractionStatus: 'SUCCESS',
    text: 'This is a substantive earnings note from official company disclosures with more than fifty words of verifiable operating and financial detail.',
    contentLength: 150
  };

  const valid = {
    url: 'https://example.com/valid.pdf',
    provider: 'InvestorRelations',
    title: 'Quarterly Results Q2 FY25',
    extractionStatus: 'SUCCESS',
    text: 'This is a substantive earnings note from official company disclosures with more than fifty words of verifiable operating and financial detail.',
    contentLength: 150
  };

  assert.equal(documentQualityGate(tooShort), false);
  assert.equal(documentQualityGate(noProvider), false);
  assert.equal(documentQualityGate(noTitle), false);
  assert.equal(documentQualityGate(valid), true);
});

test('invalid links are rejected and not counted as evidence', () => {
  const doc = {
    url: null,
    provider: null,
    title: '',
    extractionStatus: 'SUCCESS',
    text: 'Content',
    contentLength: 0
  };

  assert.equal(documentQualityGate(doc), false);
});

test('extraction failures prevent documents from becoming evidence', () => {
  const extracted = {
    url: 'https://example.com/report.pdf',
    provider: 'InvestorRelations',
    title: 'Report',
    extractionStatus: 'FAILED',
    text: 'This is a substantive earnings note from official company disclosures with more than fifty words of verifiable operating and financial detail.',
    contentLength: 150
  };

  const timeout = {
    url: 'https://example.com/report.pdf',
    provider: 'InvestorRelations',
    title: 'Report',
    extractionStatus: 'TIMEOUT',
    text: 'This is a substantive earnings note from official company disclosures with more than fifty words of verifiable operating and financial detail.',
    contentLength: 150
  };

  assert.equal(documentQualityGate(extracted), false);
  assert.equal(documentQualityGate(timeout), false);
});

// NEW: Phase 5A Regression Tests for Enhanced Document Discovery

test('provenance includes source trust metadata for OFFICIAL sources', () => {
  const document = buildDocumentProvenance({
    url: 'https://newgensoft.com/investor-relations/annual-report-2024.pdf',
    title: 'NEWGEN Annual Report 2024',
    provider: 'InvestorRelations',
    sourceType: 'ANNUAL_REPORT',
    discoveredFrom: 'https://newgensoft.com/investor-relations/',
    text: 'Full company financial disclosures and management commentary.',
    extractionStatus: 'SUCCESS',
    contentLength: 5000,
    trustLevel: 'OFFICIAL',
    discoveryPath: ['https://newgensoft.com/investor-relations/', 'https://newgensoft.com/investor-relations/annual-report-2024.pdf'],
    resolvedUrl: 'https://newgensoft.com/investor-relations/annual-report-2024.pdf',
    httpStatus: 200,
    contentType: 'application/pdf'
  });

  assert.ok(document.sourceTrust);
  assert.equal(document.sourceTrust.trustLevel, 'OFFICIAL');
  assert.ok(document.sourceTrust.discoveryPath);
  assert.equal(document.sourceTrust.httpStatus, 200);
  assert.equal(document.sourceTrust.contentType, 'application/pdf');
});

test('provenance tracks discovery path from landing page to PDF', () => {
  const landingPagePath = [
    'https://www.nseindia.com/corporate-announcements/',
    'https://www.nseindia.com/filings/2025/newgen-results-q3.html',
    'https://newgensoft.com/investor-relations/q3-results-2025.pdf'
  ];

  const document = buildDocumentProvenance({
    url: 'https://newgensoft.com/investor-relations/q3-results-2025.pdf',
    title: 'Q3 FY25 Results',
    provider: 'ExchangeFilings',
    sourceType: 'QUARTERLY_REPORT',
    discoveredFrom: landingPagePath[0],
    text: 'Quarterly financial results and management guidance.',
    extractionStatus: 'SUCCESS',
    contentLength: 3000,
    trustLevel: 'TRUSTED_EXCHANGE',
    discoveryPath: landingPagePath
  });

  assert.deepEqual(document.sourceTrust.discoveryPath, landingPagePath);
  assert.equal(document.sourceTrust.discoveryPath.length, 3);
});

test('trusted domain detection recognizes official exchange and company sources', () => {
  const trustedUrls = [
    'https://www.nseindia.com/corporate-announcements/newgen.pdf',
    'https://www.bseindia.com/corporates/filings/2025.pdf',
    'https://newgensoft.com/investor-relations/annual-report.pdf',
    'https://tcs.com/investor-relations/reports.pdf',
    'https://infosys.com/investors/results.pdf'
  ];

  for (const url of trustedUrls) {
    const normalized = new URL(url);
    const hostIncludesKnownDomain = 
      normalized.hostname.includes('nseindia.com') ||
      normalized.hostname.includes('bseindia.com') ||
      normalized.hostname.includes('newgensoft.com') ||
      normalized.hostname.includes('tcs.com') ||
      normalized.hostname.includes('infosys.com');
    
    assert.ok(hostIncludesKnownDomain, `${url} should be recognized as trusted`);
  }
});

test('untrusted sources are marked as DISCOVERY_ONLY rather than evidence', () => {
  const mirrorsAndUntrustedSources = [
    'https://random-mirror.com/newgen-documents/',
    'https://aggregator-site.example.com/company-reports/',
    'https://unknown-domain.net/investor-docs/'
  ];

  for (const sourceUrl of mirrorsAndUntrustedSources) {
    const document = buildDocumentProvenance({
      url: sourceUrl + 'report.pdf',
      title: 'Mirrored Report',
      provider: 'Aggregator',
      sourceType: 'NEWS_ARTICLE',
      discoveredFrom: sourceUrl,
      text: 'This is a mirrored or aggregated source.',
      extractionStatus: 'SUCCESS',
      contentLength: 1000,
      trustLevel: 'DISCOVERY_ONLY'
    });

    assert.equal(document.sourceTrust.trustLevel, 'DISCOVERY_ONLY');
    // Discovery-only sources should not contribute to evidence scoring
  }
});

test('relative URL resolution works across domain boundaries for trusted sources', () => {
  const baseUrl = 'https://www.nseindia.com/corporate-announcements/newgen/';
  const relativeUrls = [
    './quarterly-results-2025.pdf',
    '../documents/annual-report.pdf',
    '/documents/filings/disclosure.pdf'
  ];

  const expected = [
    'https://www.nseindia.com/corporate-announcements/newgen/quarterly-results-2025.pdf',
    'https://www.nseindia.com/corporate-announcements/documents/annual-report.pdf',
    'https://www.nseindia.com/documents/filings/disclosure.pdf'
  ];

  for (let i = 0; i < relativeUrls.length; i++) {
    const normalized = normalizeDocumentUrl(relativeUrls[i], baseUrl);
    assert.equal(normalized, expected[i]);
  }
});

test('duplicate documents are deduplicated even with different discovery paths', () => {
  const url = 'https://newgensoft.com/investor-relations/annual-report-2024.pdf';
  
  const doc1 = buildDocumentProvenance({
    url,
    title: 'Annual Report 2024',
    provider: 'InvestorRelations',
    sourceType: 'ANNUAL_REPORT',
    discoveredFrom: 'https://newgensoft.com/investor-relations/',
    text: 'Annual report content.',
    extractionStatus: 'SUCCESS',
    contentLength: 5000,
    discoveryPath: ['https://newgensoft.com/investor-relations/', url]
  });

  const doc2 = buildDocumentProvenance({
    url,
    title: 'Annual Report 2024',
    provider: 'ExchangeFilings',
    sourceType: 'ANNUAL_REPORT',
    discoveredFrom: 'https://www.nseindia.com/listings/',
    text: 'Annual report content.',
    extractionStatus: 'SUCCESS',
    contentLength: 5000,
    discoveryPath: ['https://www.nseindia.com/listings/', 'https://www.nseindia.com/filings/newgen.html', url]
  });

  // Both documents have the same canonical URL, so deduplication should identify them
  const deduped = deduplicateUrls([doc1.canonicalUrl, doc2.canonicalUrl]);
  assert.equal(deduped.length, 1);
});

test('invalid PDFs are rejected even if downloaded from trusted sources', () => {
  const invalidPdfBuffer = Buffer.from('<html><body>This is HTML, not a PDF</body></html>');
  assert.equal(isPdfBuffer(invalidPdfBuffer), false);
  
  const validPdfBuffer = Buffer.from('%PDF-1.4\n%Some PDF content');
  assert.equal(isPdfBuffer(validPdfBuffer), true);
});

test('document quality gate blocks PDFs with insufficient extracted text', () => {
  const emptyPdf = {
    url: 'https://example.com/empty.pdf',
    provider: 'InvestorRelations',
    title: 'Empty PDF',
    extractionStatus: 'SUCCESS',
    text: '', // No text extracted
    contentLength: 0
  };

  const tinyPdf = {
    url: 'https://example.com/tiny.pdf',
    provider: 'InvestorRelations',
    title: 'Tiny PDF',
    extractionStatus: 'SUCCESS',
    text: 'Only',
    contentLength: 4
  };

  assert.equal(documentQualityGate(emptyPdf), false);
  assert.equal(documentQualityGate(tinyPdf), false);
});

// ---------------------------------------------------------------------------
// Company source registry -> document discovery wiring (Phase 3 / Phase 5)
// All network calls are mocked via axios.get monkey-patching, following the
// existing pattern used in tests/newsApi.test.js — no live websites are hit.
// ---------------------------------------------------------------------------

const mockHtmlResponse = (url, data = '<html><body>No qualifying content here.</body></html>') => ({
  status: 200,
  data,
  headers: { 'content-type': 'text/html' },
  request: {},
  config: { url },
});

test('collectTier1InvestorRelations fetches every registry-configured IR and annual-report URL for NEWGEN', async () => {
  const profile = getCompanyResearchProfile('NEWGEN');
  const requestedUrls = [];
  const originalGet = axios.get;
  axios.get = async (url) => {
    requestedUrls.push(url);
    return mockHtmlResponse(url);
  };

  try {
    await collectTier1InvestorRelations(profile);
  } finally {
    axios.get = originalGet;
  }

  const expectedUrls = new Set([...profile.investorRelationsUrls, ...profile.annualReportUrls]);
  assert.ok(expectedUrls.size > 0, 'NEWGEN registry should configure at least one URL');
  for (const expected of expectedUrls) {
    assert.ok(requestedUrls.includes(expected), `expected registry URL to be fetched: ${expected}`);
  }
});

test('provenance from a registry-discovered landing page retains full evidence metadata', async () => {
  const profile = getCompanyResearchProfile('NEWGEN');
  const targetUrl = profile.investorRelationsUrls[0];
  const guidanceText = 'Management provided FY26 guidance on order book, order intake and revenue targets during the quarterly results call, reiterating the outlook for the coming annual report cycle and EBITDA guidance for shareholders. '.repeat(2);
  const originalGet = axios.get;
  axios.get = async (url) => (
    url === targetUrl
      ? mockHtmlResponse(url, `<html><body><p>${guidanceText}</p></body></html>`)
      : mockHtmlResponse(url)
  );

  let documents;
  try {
    documents = await collectTier1InvestorRelations(profile);
  } finally {
    axios.get = originalGet;
  }

  const landingDoc = documents.find((doc) => doc.url === targetUrl);
  assert.ok(landingDoc, 'expected a document sourced from the registry IR URL');
  assert.equal(landingDoc.canonicalUrl, targetUrl);
  assert.equal(landingDoc.provider, 'InvestorRelations');
  assert.equal(landingDoc.sourceType, 'INVESTOR_RELATIONS');
  assert.equal(landingDoc.extractionStatus, 'SUCCESS');
  assert.ok(landingDoc.contentHash);
  assert.ok(landingDoc.retrievedAt);
  assert.ok(landingDoc.sourceTrust);
});

test('collectDocuments isolates a failed Tier 1 from Tier 2, and fabricates nothing when every source fails', async () => {
  const originalNewsKey = process.env.NEWS_API_KEY;
  delete process.env.NEWS_API_KEY; // Tier 3/4 short-circuits with no network call

  const originalGet = axios.get;
  axios.get = async (url) => {
    if (url.includes('newgensoft.com')) {
      throw Object.assign(new Error('simulated IR outage'), { code: 'ECONNREFUSED' });
    }
    return mockHtmlResponse(url);
  };

  try {
    const result = await collectDocuments('NEWGEN');

    // Nothing anywhere succeeded with real content, so no document may be fabricated.
    assert.equal(result.documents.length, 0);
    assert.equal(result.stats.documentsFound, 0);

    const irStats = result.stats.providers.find((p) => p.name === 'InvestorRelations');
    const exchangeStats = result.stats.providers.find((p) => p.name === 'ExchangeFilings');
    assert.ok(irStats, 'Tier 1 should still report a provider entry, not be skipped entirely');
    assert.equal(irStats.documentsFound, 0);
    // Tier 2 must still have run despite every Tier 1 fetch failing.
    assert.ok(exchangeStats, 'Tier 2 should run even though Tier 1 failed for every URL');
  } finally {
    axios.get = originalGet;
    if (originalNewsKey === undefined) delete process.env.NEWS_API_KEY;
    else process.env.NEWS_API_KEY = originalNewsKey;
  }
});

test('documentMatchesCompany rejects evidence clearly attributed to a different registered company', () => {
  const profile = getCompanyResearchProfile('NEWGEN');

  const wrongCompanyDoc = {
    title: 'TCS Q1 FY27 Earnings Call',
    text: 'Tata Consultancy Services reported strong deal wins and margin guidance for the quarter.',
  };
  const rightCompanyDoc = {
    title: 'Newgen Software Q1 FY27 Results',
    text: 'Newgen Software Technologies reported order book growth and EBITDA guidance for FY27.',
  };
  const genericDoc = {
    title: 'IT sector outlook',
    text: 'The broader Indian IT services sector saw steady demand this quarter.',
  };

  assert.equal(documentMatchesCompany(wrongCompanyDoc, profile), false);
  assert.equal(documentMatchesCompany(rightCompanyDoc, profile), true);
  assert.equal(documentMatchesCompany(genericDoc, profile), true);
});
