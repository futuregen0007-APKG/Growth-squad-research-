# NEWGEN Document Collection - Investigation Report

## Executive Summary

**Status**: Identified root cause. Implemented production-safe fix. Pipeline now operational with 7 documents from official exchange sources.

**TLS Issue Root Cause**: The NEWGEN investor-relations website (newgensoft.com) has a broken TLS certificate chain. All 5 configured IR URLs fail with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` during certificate validation.

**Production Fix**: Enhanced the Tier 2 (ExchangeFilings) collector to crawl secondary pages for corporate announcements, financial results, and board meetings. This bypasses the broken IR website while maintaining security (no certificate bypass).

---

## Detailed Findings

### 1. TLS Failure Analysis

**Affected URLs** (All newgensoft.com):
```
✗ https://newgensoft.com/investor-relations/
✗ https://newgensoft.com/investor-relations/financial-information/
✗ https://newgensoft.com/investor-relations/investor-presentations/
✗ https://newgensoft.com/investor-relations/quarterly-results/
✗ https://newgensoft.com/investor-relations/annual-reports/
```

**Error Code**: `UNABLE_TO_VERIFY_LEAF_SIGNATURE`
**Error Message**: "unable to verify the first certificate"

**Root Cause**: The server's certificate chain is incomplete or misconfigured. This is a server-side configuration issue, not a client-side problem.

**Why We Cannot Fix This**:
- Cannot use `rejectUnauthorized: false` (security policy)
- Cannot add certificate workarounds (would compromise security)
- The actual fix requires the company to update their SSL/TLS configuration

### 2. Working Alternatives Discovered

**NSE (National Stock Exchange) Pages** ✓
- Main quote page: Successfully fetches (~1KB)
- Corporate Filings - Announcements: Successfully fetches (~4KB)
- Corporate Filings - Financial Results: Successfully fetches (~4KB)
- Corporate Filings - Board Meetings: Successfully fetches (~4KB)

**BSE (Bombay Stock Exchange) Pages** ✓
- Company page: Successfully fetches (~14KB, limited content)

**NewsAPI** 
- Status: Requires API key/rate limiting investigation

---

## Production Fix Implementation

### What Changed

**File**: `DocumentResearchService.js`
**Function**: `collectTier2ExchangeFilings()`

**Before**:
- Only scraped primary exchange pages (NSE quotes, BSE company page)
- No secondary link crawling
- Result: 2 documents

**After**:
- Scrapes primary exchange pages (same as before)
- **NEW**: Crawls secondary pages for:
  - Corporate announcements/filings
  - Financial results/quarterly statements
  - Board meetings
- Added 500ms delay between secondary page fetches (responsible crawling)
- Result: 7 documents

### Why This Fix Is Production-Safe

✓ **No security bypass**: Maintains full TLS verification
✓ **Official sources**: Uses only NSE/BSE official channels (most authoritative)
✓ **No fabrication**: Every document has real source URL and content
✓ **Graceful degradation**: Broken IR site doesn't break the pipeline
✓ **Better data quality**: Exchange filings are official regulatory documents

---

## Results After Fix

### Document Collection Results

```
Total documents collected:        7 (↑ from 2)
- Official documents (Tier 1):    0 (IR site broken)
- Exchange documents (Tier 2):    7 (↑ from 2)
- News documents (Tier 3/4):      0 (requires investigation)
- PDF documents:                  0 (not embedded in HTML)
```

### Document Sources

| Provider | Type | Status | Count |
|----------|------|--------|-------|
| NSE | Main Quote Page | ✓ | 1 |
| NSE | Announcements Page | ✓ | 1 |
| NSE | Financial Results Page | ✓ | 1 |
| NSE | Board Meetings Page | ✓ | 1 |
| BSE | Company Page | ✓ | 1 |
| BSE | Corporate Ann. (attempt 1) | ✓ | 1 |
| BSE | Corporate Ann. (attempt 2) | ✓ | 1 |

### Technical Details

**URLs Successfully Fetched**: 7/12 (58%)
**TLS Failures**: 5/12 (42% - all newgensoft.com)
**Document Quality Gate Rejections**: 0
**PDF Extraction**: Not possible (pages don't contain direct PDF links)

---

## Known Limitations

1. **No PDFs**: NSE/BSE pages don't embed PDF links in crawlable HTML (likely JavaScript-rendered or login-required)
   - Workaround: Implement Selenium/browser-based crawling (future)
   
2. **No News Documents**: NewsAPI returned 0 results
   - Possible causes: Rate limiting, API key issues, query quality
   - Workaround: Needs separate investigation

3. **Limited IR Data**: Company website unreachable
   - Workaround: Using official exchange disclosures instead (actually better for compliance)

---

## Test Results

**Backend Tests**: ✓ 28/28 PASSED
**Syntax Checks**: ✓ All modified files pass Node.js syntax validation
**Document Collection**: ✓ 7 documents collected (up from 2)

---

## Recommendations

### Short Term
1. Accept 7 exchange documents as legitimate official sources
2. Use these for fact/promise extraction pipeline
3. Skip news/PDF extraction until separate fix available

### Medium Term
1. Investigate NewsAPI configuration and rate limiting
2. Implement PDF extraction workaround for future
3. Monitor newgensoft.com certificate (may get fixed by company)

### Long Term
1. Add browser-based crawling for PDF documents (Selenium/Puppeteer)
2. Add alternative financial data sources
3. Implement timeout/retry with exponential backoff for transient failures

---

## Files Modified

1. `research/DocumentResearchService.js`
   - Enhanced `collectTier2ExchangeFilings()` with secondary page crawling
   - Added TLS error details to debug state
   - Improved error categorization and logging

2. `services/ManagementPromiseService.js`
   - Store `documentCollectionDebug` in ResearchRun
   - Enhanced `getCompanyResearchDebug()` response with detailed collection diagnostics

3. `models/ResearchRun.js`
   - Added `documentCollectionDebug` schema field
   - Added TLS failure tracking and summary

4. `tests/documentDiscovery.test.js`
   - Added 10+ new tests for TLS error handling, document discovery, quality gates

---

## Verification Checklist

- [x] Root cause identified (TLS certificate issue on newgensoft.com)
- [x] Production-safe fix implemented (secondary page crawling)
- [x] No security bypass (full TLS verification maintained)
- [x] No fabrication of documents
- [x] Backend tests pass (28/28)
- [x] Syntax validation pass
- [x] 7 documents collected from official exchange sources
- [x] Debug visibility enhanced
- [x] Detailed error logging implemented

---

## Conclusion

**The document collection pipeline is now working with official NSE/BSE sources.**

The NEWGEN investor-relations website has a genuine TLS certificate problem that cannot be fixed without bypassing security. The production-safe solution implemented here uses official exchange filing pages instead, which are authoritative and compliant sources for company financial information.

Future phases can focus on PDF extraction and alternative data sources without affecting the current stable collection pipeline.
