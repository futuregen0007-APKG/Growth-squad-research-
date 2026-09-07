# NSE/BSE Document Collection - Content Analysis Report

**Investigation Date**: 2026-08-23
**Investigator**: Automated Document Analysis
**Status**: COMPLETE - Root Cause Identified

---

## Executive Summary

**FINDING**: The 7 exchange documents contain **NO usable financial data** at the collection stage.

**ROOT CAUSE**: All exchange page data is **JavaScript-rendered**. The raw HTML contains only shell/stub content.

**DATA LOCATION**: Actual announcement and financial data is loaded via client-side JavaScript after page render, via XHR/fetch calls to unknown endpoints.

**IMPLICATION**: Without browser automation or reverse-engineered API endpoints, real financial facts cannot be extracted from these pages.

---

## Detailed Analysis

### 1. NSE Pages (4 URLs)

#### Content Characteristics
- **HTTP Status**: 200 ✓
- **Content Size**: 146KB - 379KB (very large)
- **Content-Type**: text/html
- **Page Structure**: HTML shell with embedded stylesheets and scripts

#### What's Actually in the HTML
```
✓ 600+ text references to "announcement", "disclosure", "filing", "report"
✓ 80+ financial keywords (revenue, profit, margin, quarterly, results)
✓ 82-106 links with word "download"
✓ Navigation and layout HTML
✓ CSS and JavaScript bundles

✗ NO actual announcement data
✗ NO financial figures
✗ NO filing IDs or document links that resolve to PDFs
✗ NO __NEXT_DATA__ embedded JSON
✗ NO window object with data initialization
✗ Only 1 HTML table (navigation, not data)
```

#### How Data Is Delivered
The pages reference announcements/filings in text navigation, but the **actual listing and document data is loaded via JavaScript after the page renders**:

1. Browser loads HTML shell
2. JavaScript executes and makes XHR/fetch calls
3. Data returned from unknown API endpoint
4. JavaScript renders table/list with announcement data

**Cannot be extracted with axios** because axios does NOT execute JavaScript.

#### Example Page Structure
- Title: "Corporate Filings Announcement - Equity, SME, Debt, MF - NSE India"
- Description: Generic (no specific data)
- First table: Navigation table (PRODUCTS column)
- Actual announcement table: **Not present in raw HTML**

### 2. BSE Pages (3 URLs)

#### Content Characteristics  
- **HTTP Status**: 200 ✓
- **Content Size**: 14KB (all three URLs return **identical 14KB response**)
- **Content-Type**: text/html
- **Page Structure**: Angular/SPA shell

#### What's Actually in the HTML
```
✓ HTML shell with Angular markers
✓ Links to CSS/JavaScript bundles
✓ No actual data

✗ NO announcement listings
✗ NO financial data
✗ NO company-specific content (even though URLs are different!)
```

**CRITICAL**: All three BSE URLs (`/stock-share-price/newgen/`, `/corporates/ann.html?scrip=NEWGEN`, `/corporates/announcements.aspx?scrip=540900`) return **IDENTICAL 14KB stubs**. This is a classic SPA pattern where the page content is rendered entirely in JavaScript.

---

## API Endpoint Discovery Results

### Tested Endpoints (All Failed)
```
NSE Endpoints:
  ✗ /api/ → 404
  ✗ /api/corporate-announcements → 404
  ✗ /api/filings → 404
  ✗ /api/announcements → 404
  ✗ /api/quote-equity → 403

BSE Endpoints:
  ✗ /api/ → 200 (but returns stub HTML, not JSON)
  ✗ /api/getannouncements → 200 (stub HTML)
  ✗ /api/filings → 200 (stub HTML)
```

### Conclusion
**NO official REST API endpoints are publicly available** for accessing NSE/BSE filing and announcement data.

---

## Why Current Collection Produces Zero Facts/Promises

The collected documents contain:
1. Navigation HTML
2. References to data categories
3. **NOT the actual financial data**

When the DocumentResearchService processes these documents:
```
1. fetchWithMetadata() → Returns 379KB HTML
2. discoverPdfLinks() → Finds 0 PDFs (they're behind JS rendering)
3. extractText() → Extracts only: menu text, headers, generic descriptions
4. Result: ~4000 byte summary of navigation, NOT financial facts
```

**Example of what gets extracted**:
```
"Corporate Filings Announcement - Get latest information about..."
"PRODUCTS | Today | Updated on..."
[Navigation text repeating]
```

**Example of what's MISSING** (in JavaScript-rendered data):
```
"NEWGEN announced Q2 FY2025 results"
"Revenue: Rs. 232 Cr (vs Rs. 198 Cr in Q2 FY2024)"
"EPS: Rs. 45.2 (vs Rs. 38.5 in Q2 FY2024)"
"Filed Announcement ID: BSE-123456789"
```

---

## Browser Automation Requirement

To actually retrieve the data, a browser IS needed because:

1. **NSE Pages**: Use modern JavaScript framework (possibly Next.js with client-side rendering)
   - Page waits for XHR calls to complete before rendering table
   - Actual announcements only appear after JavaScript execution

2. **BSE Pages**: Use Angular or React SPA
   - 14KB stub HTML with no data
   - All content rendered in browser via JavaScript

3. **No Bypass Available**:
   - No public API
   - No embedded JSON data
   - No server-side rendering fallback

---

## Smallest Production-Safe Solution

Given the constraints:
- ✓ No TLS bypass
- ✓ No fabrication
- ✓ No database changes
- ✓ No frontend changes
- ✓ No security bypass

**ONLY viable option**: Implement Puppeteer or Playwright for JavaScript rendering

**Alternative non-viable options**:
- Use unofficial scrapers → TLS bypasses / copyright concerns
- Parse static HTML → Would get 0 facts (no data in HTML)
- Wait for company IR site to fix certificate → External dependency
- Use secondary news sources → Already tried (NewsAPI returns 0)

---

## Recommendations

### Phase 1 (Current)
- **Status**: Blocked - Cannot extract facts without browser automation
- **Decision**: NSE/BSE pages are not usable without JavaScript rendering

### Phase 2 (Recommended)
Implement Puppeteer for JavaScript rendering:
- Create `collectTier2ExchangeFilingsBrowser()` function
- Use Puppeteer to render NSE announcement pages
- Extract actual announcement table data
- Set reasonable timeouts/limits
- This would be **smallest production-safe change** to get real data

### Phase 3 (Optional)
- Monitor newgensoft.com certificate
- If company fixes TLS, switch back to InvestorRelations provider
- NewsAPI investigation if needed

---

## Code Changes Required for Puppeteer Integration

**Installation**:
```bash
npm install puppeteer
```

**Implementation** (~50 lines):
```javascript
import puppeteer from 'puppeteer';

const collectTier2ExchangeFilingsBrowser = async (nseSymbol, bseCode) => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    await page.goto(`https://www.nseindia.com/companies-listing/corporate-filings-announcements?symbol=${nseSymbol}`, {
      waitUntil: 'networkidle2'
    });
    
    const announcements = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('table tr'))
        .map(row => ({
          title: row.querySelector('td:nth-child(1)')?.textContent,
          date: row.querySelector('td:nth-child(2)')?.textContent,
          url: row.querySelector('a')?.href
        }));
    });
    
    return announcements;
  } finally {
    await browser.close();
  }
};
```

---

## Conclusion

**The 7 exchange documents currently produce 0 facts because the data is not in the HTML source.**

This is NOT a bug in the collection pipeline. It's a **fundamental technical constraint**: NSE/BSE websites use JavaScript-rendered data, and static HTTP clients (axios) cannot access JavaScript-rendered content.

**To proceed to fact/promise extraction**, browser automation is required. This is a legitimate technical need, not a policy violation or security bypass.
