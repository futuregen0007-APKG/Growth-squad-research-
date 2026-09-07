#!/usr/bin/env node
/**
 * Phase 7: Manual PDF test with known TCS PDF URL
 */

import mongoose from 'mongoose';
import { fetchPdf, buildDocumentProvenance, documentQualityGate } from './research/DocumentResearchService.js';
import { extractPromisesFromDocument } from './services/PromiseExtractionService.js';
import ManagementPromise from './models/ManagementPromise.js';

const testManualPDF = async () => {
  console.log('\n' + '='.repeat(80));
  console.log('PHASE 7 MANUAL PDF TEST');
  console.log('='.repeat(80) + '\n');

  // Connect to database
  if (mongoose.connection.readyState !== 1) {
    try {
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/stock-market-ai');
      console.log('✓ Database connected\n');
    } catch (error) {
      console.log('✗ Database connection failed:', error.message);
      process.exit(1);
    }
  }

  // Use a known TCS PDF URL from previous tests
  const pdfUrl = 'https://www.tcs.com/content/dam/tcs/pdf/investor-relations/annual-report-2023-2024.pdf';
  
  console.log(`Fetching PDF from: ${pdfUrl}\n`);
  
  try {
    const pdfResult = await fetchPdf(pdfUrl);
    
    if (!pdfResult.ok) {
      console.log('✗ PDF fetch failed:', pdfResult.error);
      process.exit(1);
    }
    
    console.log('✓ PDF fetched successfully');
    console.log(`  Size: ${pdfResult.data.length} bytes`);
    console.log(`  Final URL: ${pdfResult.finalUrl}\n`);
    
    // Extract PDF text inline
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: pdfResult.data });
    const parsed = await parser.getText();
    await parser.destroy();
    
    const extractedText = {
      text: parsed.text || '',
      pages: (parsed.pages || []).map((page, index) => ({
        pageNumber: index + 1,
        text: page.text || ''
      }))
    };
    
    if (!extractedText) {
      console.log('✗ PDF text extraction failed');
      process.exit(1);
    }
    
    console.log('✓ PDF text extracted successfully');
    console.log(`  Text length: ${extractedText.text.length} characters`);
    console.log(`  Pages: ${extractedText.pages.length}\n`);
    
    // Build document provenance
    const doc = buildDocumentProvenance({
      url: pdfUrl,
      title: 'TCS Annual Report 2023-2024',
      provider: 'ManualTest',
      sourceType: 'ANNUAL_REPORT',
      discoveredFrom: pdfUrl,
      publishedAt: '2024-04-01',
      text: extractedText.text,
      pages: extractedText.pages,
      extractionStatus: 'SUCCESS',
      contentLength: extractedText.text.length,
      trustLevel: 'OFFICIAL'
    });
    
    console.log('Document quality gate:', documentQualityGate(doc) ? 'PASSED' : 'FAILED');
    
    // Extract promises
    console.log('\nExtracting promises from PDF...\n');
    const promises = extractPromisesFromDocument(doc);
    
    console.log(`✓ Extracted ${promises.length} promises\n`);
    
    if (promises.length > 0) {
      promises.forEach((p, idx) => {
        console.log(`Promise ${idx + 1}:`);
        console.log(`  Statement: ${p.statement}`);
        console.log(`  Metric: ${p.metric}`);
        console.log(`  Target: ${p.targetValue} ${p.targetUnit}`);
        console.log(`  Period: ${p.period}`);
        console.log(`  Source: ${p.evidence?.sourceUrl}`);
        console.log('');
      });
      
      // Save to database
      console.log('Saving promises to database...\n');
      let saved = 0;
      for (const p of promises) {
        try {
          const record = {
            companyId: 'TCS',
            symbol: 'TCS',
            companyName: 'Tata Consultancy Services',
            dataOrigin: 'REAL_RESEARCH',
            promise: {
              statement: p.statement,
              metric: p.metric,
              targetValue: p.targetValue,
              targetUnit: p.targetUnit,
              targetPeriod: p.period || 'FY2024',
              promiseDate: p.evidence?.sourceDate || new Date(),
              direction: p.direction || 'HIGHER_IS_BETTER',
              operator: p.operator || null,
              importance: 'MEDIUM'
            },
            evidence: {
              promiseSource: {
                sourceType: 'ANNUAL_REPORT',
                sourceName: p.evidence?.documentTitle || 'TCS Annual Report',
                sourceUrl: p.evidence?.sourceUrl,
                sourceDate: p.evidence?.publicationDate || p.evidence?.sourceDate,
                publicationDate: p.evidence?.publicationDate || p.evidence?.sourceDate,
                page: p.evidence?.page,
                title: p.evidence?.documentTitle,
                excerpt: p.evidence?.excerpt,
                documentType: 'ANNUAL_REPORT',
                authorityLevel: 1.0
              }
            },
            verification: {
              status: 'PENDING',
              achievementPercentage: null,
              calculationExplanation: 'Outcome not yet verified',
              confidence: 1.0
            },
            // Backward compatible fields
            promiseTitle: p.statement,
            promiseText: p.statement,
            promiseDescription: p.statement,
            metric: p.metric,
            metricType: 'QUANTITATIVE',
            targetValue: p.targetValue,
            targetUnit: p.targetUnit,
            targetPeriod: p.period || 'FY2024',
            status: 'PENDING',
            sourceUrl: p.evidence?.sourceUrl,
            sourceDate: p.evidence?.publicationDate || p.evidence?.sourceDate,
            sourceExcerpt: p.evidence?.excerpt,
            confidence: 1.0
          };
          
          await ManagementPromise.updateOne(
            {
              symbol: 'TCS',
              'promise.statement': p.statement,
              'evidence.promiseSource.sourceUrl': p.evidence?.sourceUrl
            },
            { $set: record },
            { upsert: true }
          );
          saved++;
        } catch (error) {
          console.log(`✗ Failed to save promise: ${error.message}`);
        }
      }
      
      console.log(`✓ Saved ${saved} promises to database\n`);
      
      const totalCount = await ManagementPromise.countDocuments({ symbol: 'TCS', dataOrigin: 'REAL_RESEARCH' });
      console.log(`Total TCS promises in database: ${totalCount}\n`);
      
    } else {
      console.log('No promises found in PDF');
    }
    
  } catch (error) {
    console.log('Error:', error.message);
    console.log(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('\nDatabase disconnected\n');
  }

  process.exit(0);
};

await testManualPDF();
