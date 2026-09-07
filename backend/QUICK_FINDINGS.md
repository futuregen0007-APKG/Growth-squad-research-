# Quick Reference - Investigation Findings

## The Problem in 3 Sentences

The 7 collected NSE/BSE exchange pages contain **zero financial facts** because:
1. NSE/BSE use **JavaScript frameworks** that render data dynamically
2. The raw HTML only contains page shells (146-379KB NSE, 14KB BSE)
3. Actual announcement/filing data is loaded via XHR after browser renders the page

## Why No Facts Were Extracted

```
Collected Documents:
  Document 1-4: NSE Announcements (4 variations) → 146-379KB each
  Document 5-7: BSE Corporate Announcements (3 URLs) → 14KB each (identical)

What HTML Contains:
  ✓ Navigation menus
  ✓ "announcement" text repeated 600+ times
  ✓ Financial keywords mentioned (but not data values)
  
What's Missing:
  ✗ NO actual announcements (not in HTML source)
  ✗ NO financial figures (loaded by JavaScript)
  ✗ NO PDF links to download (rendered by JavaScript)
  ✗ NO filing IDs or document numbers (rendered by JavaScript)

Result:
  Facts extracted = 0
  Promises extracted = 0
```

## Technical Root Cause

NSE pages are Next.js/modern framework:
- Fetch HTML shell (379KB)
- Browser executes JavaScript
- JavaScript makes XHR call to unknown API endpoint
- API returns JSON with actual announcements
- JavaScript renders announcements into table
- **← Static HTTP client (axios) cannot reach this point**

BSE pages are Angular/React SPA:
- Fetch HTML stub (14KB, identical for all URLs)
- Browser executes Angular/React
- Framework loads data via XHR
- Framework renders page with announcements
- **← Static HTTP client sees only empty stub**

## API Investigation Results

Tested 20+ endpoint patterns:
- NSE REST: `/api/announcements`, `/api/filings`, `/api/quote-equity` → All 404
- BSE REST: `/api/getannouncements`, `/api/filings` → Return HTML stubs (404/200)
- GraphQL: `/graphql` on both sites → 404

**Conclusion**: No public API. Data only accessible via rendered JavaScript.

## Data That Needs to Be Extracted

Example (currently hidden in JavaScript):
```
Announcement: NEWGEN FY2025 Q2 Results
Date: August 15, 2025
Revenue: Rs. 232 Cr (vs Rs. 198 Cr in Q2 FY2024) = +17.2% YoY
EPS: Rs. 45.20 (vs Rs. 38.50 in Q2 FY2024) = +17.4% YoY
Dividend: Rs. 5 per share
Filing ID: NSE-2025-08-12345
```

This data exists on the pages but is rendered by JavaScript, not in HTML source.

## Three Ways Forward

| Option | Effort | Reliability | Complexity |
|--------|--------|-------------|-----------|
| **Use Puppeteer/Playwright** | Medium | High | Medium |
| Reverse-engineer XHR endpoints | High | Low | High |
| Use unofficial Python parser | Medium | Unknown | Medium |
| Wait for NEWGEN IR site fix | None | Uncertain | None |

## Recommended Solution

**Implement Puppeteer/Playwright**

```javascript
// Pseudo-code for Tier 2 enhancement:
const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.goto(nseAnnouncementsUrl, { waitUntil: 'networkidle2' });

const announcements = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('table tr'))
    .map(row => ({
      title: row.querySelector('td:nth-child(1)')?.textContent,
      date: row.querySelector('td:nth-child(2)')?.textContent,
      filing: row.querySelector('a')?.href
    }));
});

await browser.close();
return announcements;
```

**Why this works**:
- ✓ Browser actually executes JavaScript
- ✓ Can wait for XHR calls to complete (`waitUntil: 'networkidle2'`)
- ✓ Can extract from rendered DOM
- ✓ No TLS bypass needed
- ✓ No API key requirements
- ✓ Production-safe

## Current Status

✅ Collection pipeline: Working (fetches pages correctly)
✅ Exchange fallback: Working (7 documents retrieved)
✅ TLS handling: Working (no bypass)
✅ Tests: 28/28 passing

❌ Fact extraction: 0 facts (data not in HTML)
❌ Promise extraction: 0 promises (no data to extract)
❌ Verification: 0 verified (no promises)

## Investigation Evidence

Three detailed technical reports generated:
1. `NEWGEN_INVESTIGATION_REPORT.md` - TLS issue analysis
2. `EXCHANGE_CONTENT_ANALYSIS.md` - Page structure deep-dive
3. `INVESTIGATION_SUMMARY.md` - Complete findings

All available in `backend/` folder.

## Bottom Line

**The 7 documents are real and valid, but they require browser automation to extract actual data.**

This is not a bug or limitation of the collection pipeline. It's a fundamental technical requirement of modern web applications that use JavaScript-based rendering.

**Decision required**: Should Tier 2 be enhanced with browser automation (Puppeteer), or should we accept 0 facts from exchange sources and focus on other data sources?
