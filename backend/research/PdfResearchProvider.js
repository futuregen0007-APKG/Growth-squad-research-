import pdfParse from 'pdf-parse';
import { logger } from '../utils/logger.js';
import { DOCUMENT_TYPES, SOURCE_AUTHORITY, discoverPdfLinks, fetchHtml, fetchPdf, isPdfBuffer } from './DocumentResearchService.js';

// Download PDF from URL
const downloadPdf = async (url, timeout = 30000) => {
  try {
    const result = await fetchPdf(url, timeout);
    return result.ok && isPdfBuffer(result.data) ? result.data : null;
  } catch (error) {
    logger.warn(`Failed to download PDF from ${url}: ${error.message}`);
    return null;
  }
};

// Extract text from PDF buffer
const extractPdfText = async (buffer) => {
  try {
    const data = await pdfParse(buffer);
    return {
      text: data.text,
      pages: data.numpages,
      info: data.info
    };
  } catch (error) {
    logger.error(`Failed to parse PDF: ${error.message}`);
    return null;
  }
};

// Search for PDF documents from investor relations
export class PdfResearchProvider {
  constructor() {
    this.name = 'PDF Research Provider';
  }

  async collect(symbol, companyName) {
    const documents = [];
    
    // Common PDF URL patterns for Indian companies
    const pdfUrlPatterns = [
      // Annual reports
      `https://www.${companyName.toLowerCase().replace(/\s+/g, '')}.com/investors/annual-report`,
      `https://investor.${companyName.toLowerCase().replace(/\s+/g, '')}.com/annual-reports`,
      // Investor presentations
      `https://www.${companyName.toLowerCase().replace(/\s+/g, '')}.com/investors/presentations`,
      `https://investor.${companyName.toLowerCase().replace(/\s+/g, '')}.com/presentations`,
      // Quarterly results
      `https://www.${companyName.toLowerCase().replace(/\s+/g, '')}.com/investors/quarterly-results`,
      `https://investor.${companyName.toLowerCase().replace(/\s+/g, '')}.com/quarterly-results`,
    ];
    
    // Try to fetch and parse PDFs from these URLs
    for (const baseUrl of pdfUrlPatterns) {
      try {
        // This is a simplified approach - in production, you would:
        // 1. Crawl the page to find actual PDF links
        // 2. Download each PDF
        // 3. Extract text from each PDF
        // 4. Create document records for each
        
        logger.info(`[PdfResearchProvider] Checking for PDFs at: ${baseUrl}`);
        
        const html = await fetchHtml(baseUrl);
        const links = discoverPdfLinks(html, baseUrl, this.name);
        for (const link of links) {
          const document = await this.extractFromUrl(link.url, { title: link.title });
          if (document) documents.push(document);
        }
        
      } catch (error) {
        logger.warn(`[PdfResearchProvider] Failed to check ${baseUrl}: ${error.message}`);
      }
    }
    
    return {
      provider: this.name,
      documents,
      available: documents.length > 0,
      reason: documents.length === 0 ? 'No PDF documents found (requires page crawling to discover PDF links)' : null
    };
  }
  
  // Extract text from a specific PDF URL
  async extractFromUrl(url, metadata = {}) {
    const buffer = await downloadPdf(url);
    if (!buffer) {
      return null;
    }
    
    const extracted = await extractPdfText(buffer);
    if (!extracted) {
      return null;
    }
    
    return {
      sourceType: DOCUMENT_TYPES.ANNUAL_REPORT, // Default, should be overridden
      sourceName: 'PDF Document',
      sourceUrl: url,
      sourceDate: metadata.date || new Date().toISOString(),
      publicationDate: metadata.date || new Date().toISOString(),
      title: metadata.title || 'PDF Document',
      excerpt: extracted.text.substring(0, 2000),
      fullText: extracted.text,
      pages: extracted.pages,
      documentType: DOCUMENT_TYPES.ANNUAL_REPORT, // Default
      authorityLevel: SOURCE_AUTHORITY.ANNUAL_REPORT,
      ...metadata
    };
  }
}

export default PdfResearchProvider;
