import mongoose from 'mongoose';
import dotenv from 'dotenv';
import CompanyHistoricalFact from '../models/CompanyHistoricalFact.js';
import ManagementPromise from '../models/ManagementPromise.js';
import ResearchRun from '../models/ResearchRun.js';
import { logger } from '../utils/logger.js';

dotenv.config();

export const SEED_DATA = {
  NEWGEN: {
    companyName: 'Newgen Software Technologies',
    sector: 'IT / Software',
    coverageStart: 'FY2022',
    coverageEnd: 'FY2026',
    facts: [
      // FY2026 (Completed Fiscal Year)
      {
        period: 'FY2026',
        date: new Date('2026-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY26 Consolidated Revenue Performance',
        fact: 'Newgen reported consolidated revenue of ₹1,574.4 Cr in FY26 with operating EBITDA reaching ₹406.2 Cr (25.80% margin).',
        summary: 'Driven by recurring subscription revenue, banking digital transformation, and US market expansion.',
        metrics: { metric: 'REVENUE', actualValue: 1574.4, previousValue: 1487.2, unit: 'INR_CRORE', changePercent: 5.86, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Newgen Software FY26 Audited Financial Statements (Ind AS)', url: 'https://newgensoft.com/investor-relations/financials/', publishedAt: new Date('2026-05-10'), pageNumber: 44, excerpt: 'Consolidated revenue for the year stood at Rs 1,574.4 Cr, up 5.9% YoY.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2026',
        date: new Date('2026-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY26 Net Profit (PAT) & Diluted EPS',
        fact: 'Consolidated PAT for FY26 was ₹334.8 Cr compared to ₹315.4 Cr in FY25, with Diluted EPS of ₹23.9.',
        metrics: { metric: 'PAT', actualValue: 334.8, previousValue: 315.4, unit: 'INR_CRORE', changePercent: 6.15, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Newgen Software FY26 Annual Report', url: 'https://newgensoft.com/investor-relations/financials/', publishedAt: new Date('2026-05-10'), pageNumber: 48, excerpt: 'Net Profit after Tax for FY26 closed at Rs 334.8 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2026',
        date: new Date('2026-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY26 Operating EBITDA Margin & Cash Flow',
        fact: 'EBITDA margin reached 25.80% with Operating Cash Flow of ₹345.0 Cr and Free Cash Flow of ₹310.0 Cr.',
        metrics: { metric: 'EBITDA_MARGIN', actualValue: 25.80, previousValue: 25.32, unit: 'PERCENTAGE', changePercent: 1.9, currency: 'INR' },
        source: { type: 'INVESTOR_PRESENTATION', title: 'Newgen Q4 FY26 Earnings Presentation', url: 'https://newgensoft.com/investor-relations/presentations/', publishedAt: new Date('2026-05-02'), pageNumber: 14, excerpt: 'Full year EBITDA margin expanded to 25.8% with operating cash flow conversion of 103% of PAT.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2026',
        date: new Date('2026-03-31'),
        category: 'CAPEX',
        title: 'Zero Debt & Liquid Reserves Position',
        fact: 'Newgen maintained a zero debt balance sheet with cash, bank balances and liquid mutual fund investments totaling ₹685.0 Cr.',
        metrics: { metric: 'DEBT', actualValue: 0, previousValue: 0, unit: 'INR_CRORE', changePercent: 0, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Newgen FY26 Balance Sheet Disclosures', url: 'https://newgensoft.com/investor-relations/financials/', publishedAt: new Date('2026-05-10'), pageNumber: 82, excerpt: 'The company remains entirely debt-free with cash and cash equivalents of Rs 685.0 Cr.' },
        confidence: 0.98, verified: true
      },
      // FY2025
      {
        period: 'FY2025',
        date: new Date('2025-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY25 Annual Financial Delivery',
        fact: 'Newgen reported consolidated revenue of ₹1,487.2 Cr with a PAT of ₹315.4 Cr (19.6% YoY revenue growth).',
        metrics: { metric: 'REVENUE', actualValue: 1487.2, previousValue: 1243.8, unit: 'INR_CRORE', changePercent: 19.57, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Newgen Software FY25 Annual Report & Financial Statements', url: 'https://newgensoft.com/investor-relations/financials/', publishedAt: new Date('2025-05-15'), pageNumber: 42, excerpt: 'Consolidated revenue for the year stood at Rs 1,487.2 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2025',
        date: new Date('2025-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY25 PAT & Operating Profitability',
        fact: 'Consolidated PAT reached ₹315.4 Cr for FY25 with EBITDA margin at 25.32% and Diluted EPS of ₹22.5.',
        metrics: { metric: 'PAT', actualValue: 315.4, previousValue: 251.6, unit: 'INR_CRORE', changePercent: 25.36, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Newgen Software FY25 Financial Statements', url: 'https://newgensoft.com/investor-relations/financials/', publishedAt: new Date('2025-05-15'), pageNumber: 46, excerpt: 'PAT for the year grew 25.4% to Rs 315.4 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2025',
        date: new Date('2025-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY25 EBITDA Margin Delivery',
        fact: 'EBITDA margin for FY25 concluded at 25.32%.',
        metrics: { metric: 'EBITDA_MARGIN', actualValue: 25.32, previousValue: 24.10, unit: 'PERCENTAGE', changePercent: 5.06, currency: 'INR' },
        source: { type: 'INVESTOR_PRESENTATION', title: 'Newgen FY25 Q4 Presentation', url: 'https://newgensoft.com/investor-relations/presentations/', publishedAt: new Date('2025-05-02'), excerpt: 'Operating EBITDA margin recorded at 25.32%.' },
        confidence: 0.98, verified: true
      },
      // FY2024
      {
        period: 'FY2024',
        date: new Date('2024-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY24 Strong Revenue Growth Milestone',
        fact: 'Newgen achieved revenue of ₹1,243.8 Cr in FY24, crossing the ₹1,200 Cr landmark with 27.70% YoY expansion from ₹974.0 Cr in FY23.',
        metrics: { metric: 'REVENUE', actualValue: 1243.8, previousValue: 974.0, unit: 'INR_CRORE', changePercent: 27.70, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Newgen Software FY24 Annual Report', url: 'https://newgensoft.com/investor-relations/financials/', publishedAt: new Date('2024-05-20'), pageNumber: 38, excerpt: 'FY24 consolidated revenue grew by 27.7% to Rs 1,243.8 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2024',
        date: new Date('2024-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY24 PAT Performance',
        fact: 'FY24 PAT stood at ₹251.6 Cr compared to ₹214.8 Cr in FY23 (17.13% YoY growth) with EBITDA margin of 24.10% and Diluted EPS of ₹17.9.',
        metrics: { metric: 'PAT', actualValue: 251.6, previousValue: 214.8, unit: 'INR_CRORE', changePercent: 17.13, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Newgen Software FY24 Annual Report', url: 'https://newgensoft.com/investor-relations/financials/', publishedAt: new Date('2024-05-20'), pageNumber: 42, excerpt: 'Profit after tax stood at Rs 251.6 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2024',
        date: new Date('2024-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY24 EBITDA Margin',
        fact: 'FY24 EBITDA margin stood at 24.10%.',
        metrics: { metric: 'EBITDA_MARGIN', actualValue: 24.10, previousValue: 22.08, unit: 'PERCENTAGE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Newgen FY24 Financial Statements', url: 'https://newgensoft.com', publishedAt: new Date('2024-05-20'), excerpt: 'EBITDA margin was 24.10%.' },
        confidence: 0.98, verified: true
      },
      // FY2023
      {
        period: 'FY2023',
        date: new Date('2023-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY23 Enterprise Revenue Expansion',
        fact: 'Newgen delivered consolidated revenue of ₹974.0 Cr in FY23, up 25.03% from ₹779.0 Cr in FY22.',
        metrics: { metric: 'REVENUE', actualValue: 974.0, previousValue: 779.0, unit: 'INR_CRORE', changePercent: 25.03, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Newgen Software FY23 Annual Report', url: 'https://newgensoft.com/investor-relations/financials/', publishedAt: new Date('2023-05-18'), pageNumber: 32, excerpt: 'Revenue reached Rs 974.0 Cr with strong license additions.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2023',
        date: new Date('2023-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY23 Net Profit Delivery',
        fact: 'FY23 Net Profit reached ₹214.8 Cr with PAT margin of 22.05% and Diluted EPS of ₹15.3.',
        metrics: { metric: 'PAT', actualValue: 214.8, previousValue: 164.2, unit: 'INR_CRORE', changePercent: 30.82, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Newgen Software FY23 Annual Report', url: 'https://newgensoft.com/investor-relations/financials/', publishedAt: new Date('2023-05-18'), excerpt: 'Net profit for the year grew 30.8% to Rs 214.8 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2023',
        date: new Date('2023-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY23 EBITDA Margin',
        fact: 'FY23 EBITDA margin concluded at 22.08%.',
        metrics: { metric: 'EBITDA_MARGIN', actualValue: 22.08, previousValue: 24.93, unit: 'PERCENTAGE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Newgen FY23 Financials', url: 'https://newgensoft.com', publishedAt: new Date('2023-05-18'), excerpt: 'EBITDA margin stood at 22.08%.' },
        confidence: 0.98, verified: true
      },
      // FY2022
      {
        period: 'FY2022',
        date: new Date('2022-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY22 Financial Base Delivery',
        fact: 'FY22 consolidated revenue was ₹779.0 Cr with PAT of ₹164.2 Cr, EBITDA of ₹194.2 Cr (24.93% margin), and zero long-term debt.',
        metrics: { metric: 'REVENUE', actualValue: 779.0, unit: 'INR_CRORE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Newgen Software FY22 Annual Report', url: 'https://newgensoft.com/investor-relations/financials/', publishedAt: new Date('2022-05-24'), pageNumber: 28, excerpt: 'Full year FY22 revenue stood at Rs 779.0 Cr with PAT of Rs 164.2 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2022',
        date: new Date('2022-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY22 PAT Base',
        fact: 'FY22 PAT was ₹164.2 Cr.',
        metrics: { metric: 'PAT', actualValue: 164.2, unit: 'INR_CRORE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Newgen FY22 Financials', url: 'https://newgensoft.com', publishedAt: new Date('2022-05-24'), excerpt: 'PAT was Rs 164.2 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2022',
        date: new Date('2022-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY22 EBITDA Margin Base',
        fact: 'FY22 EBITDA margin was 24.93%.',
        metrics: { metric: 'EBITDA_MARGIN', actualValue: 24.93, unit: 'PERCENTAGE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Newgen FY22 Financials', url: 'https://newgensoft.com', publishedAt: new Date('2022-05-24'), excerpt: 'EBITDA margin stood at 24.93%.' },
        confidence: 0.98, verified: true
      },
      // Strategic & Contract Events
      {
        period: 'FY2026',
        date: new Date('2025-11-12'),
        category: 'PRODUCT',
        title: 'NewgenONE Marvin GenAI Agentic Architecture Launch',
        fact: 'Newgen released its integrated AI platform NewgenONE Marvin incorporating agentic AI for intelligent document processing and loan automation across 60+ global financial institutions.',
        source: { type: 'PRESS_RELEASE', title: 'Newgen Launches GenAI platform NewgenONE Marvin', url: 'https://newgensoft.com/newsroom/press-releases/', publishedAt: new Date('2025-11-12'), excerpt: 'Newgen introduces NewgenONE Marvin, embedding generative AI agents across document processing.' },
        confidence: 0.95, verified: true
      },
      {
        period: 'FY2025',
        date: new Date('2024-09-18'),
        category: 'CONTRACT',
        title: 'Major International Tier-1 Bank Deal Win',
        fact: 'Newgen secured a multi-million dollar contract with a leading Southeast Asian banking group to modernize trade finance and commercial loan origination.',
        metrics: { metric: 'DEAL_WINS', actualValue: 45, unit: 'USD_MILLION', currency: 'INR' },
        source: { type: 'EXCHANGE_FILING', title: 'NSE Corporate Announcement - International Contract Award', url: 'https://www.nseindia.com/companies-listing/corporate-filings', publishedAt: new Date('2024-09-18'), excerpt: 'Newgen awarded significant multi-year digital transformation mandate by leading commercial bank.' },
        confidence: 0.95, verified: true
      }
    ],
    promises: [
      {
        promiseTitle: 'FY24 20%+ Revenue Growth Guidance',
        promiseDescription: 'Management guided for 20-25% annual revenue growth in FY24 driven by banking software demand.',
        financialYear: 'FY24',
        metric: 'REVENUE_GROWTH',
        targetValue: 20.0,
        targetUnit: 'PERCENTAGE',
        targetPeriod: 'FY2024',
        actualValue: 27.7,
        actualUnit: 'PERCENTAGE',
        achievementPercentage: 110.8,
        status: 'FULFILLED',
        promise: {
          statement: 'We expect to sustain 20-25% annual revenue growth in FY24 backed by our strong enterprise pipeline.',
          metric: 'REVENUE_GROWTH',
          targetValue: 20.0,
          targetUnit: 'PERCENTAGE',
          targetPeriod: 'FY2024',
          direction: 'HIGHER_IS_BETTER',
          importance: 'HIGH'
        },
        outcome: {
          actualValue: 27.7,
          actualUnit: 'PERCENTAGE',
          outcomePeriod: 'FY2024',
          description: 'FY24 revenue grew 27.7% YoY to ₹1,243.8 Cr, exceeding the guidance target.'
        },
        verification: {
          status: 'FULFILLED',
          achievementPercentage: 110.8,
          verifiedAt: new Date('2024-05-15'),
          calculationExplanation: 'Target 20.0%, Actual 27.7% (Achievement = 27.7 / 20.0 * 100 = 110.8%).'
        },
        evidence: {
          promiseSource: {
            title: 'Newgen Q4 FY23 Earnings Call Transcript',
            sourceUrl: 'https://newgensoft.com/investor-relations/transcripts/',
            sourceType: 'EARNINGS_CALL',
            excerpt: 'We are guiding for 20-25% top-line growth in FY24.'
          },
          outcomeSource: {
            title: 'Newgen FY24 Audited Financial Statement',
            sourceUrl: 'https://newgensoft.com/investor-relations/financials/',
            sourceType: 'ANNUAL_REPORT',
            page: 38,
            excerpt: 'Revenue expanded 27.7% YoY to Rs 1,243.8 Cr.'
          }
        }
      },
      {
        promiseTitle: 'FY25 Operating Margin Band Guidance (22-25%)',
        promiseDescription: 'Management targeted maintaining EBITDA margin in the 22-25% band while continuing R&D investments.',
        financialYear: 'FY25',
        metric: 'EBITDA_MARGIN',
        targetValue: 22.0,
        targetUnit: 'PERCENTAGE',
        targetPeriod: 'FY2025',
        actualValue: 25.32,
        actualUnit: 'PERCENTAGE',
        achievementPercentage: 100,
        status: 'FULFILLED',
        promise: {
          statement: 'We aim to sustain EBITDA margins within the 22% to 25% range in FY25.',
          metric: 'EBITDA_MARGIN',
          targetValue: 22.0,
          targetUnit: 'PERCENTAGE',
          targetPeriod: 'FY2025',
          direction: 'HIGHER_IS_BETTER',
          importance: 'MEDIUM'
        },
        outcome: {
          actualValue: 25.32,
          actualUnit: 'PERCENTAGE',
          outcomePeriod: 'FY2025',
          description: 'FY25 EBITDA margin finished at 25.32%.'
        },
        verification: {
          status: 'FULFILLED',
          achievementPercentage: 100,
          verifiedAt: new Date('2025-05-15'),
          calculationExplanation: 'Target 22.0-25.0%, Actual 25.32% (Exceeded upper bound of guidance range).'
        },
        evidence: {
          promiseSource: {
            title: 'Newgen Q4 FY24 Investor Conference Call',
            sourceUrl: 'https://newgensoft.com/investor-relations/transcripts/',
            sourceType: 'EARNINGS_CALL',
            excerpt: 'Our focus is sustaining 22-25% operating margins.'
          },
          outcomeSource: {
            title: 'Newgen FY25 Earnings Disclosures',
            sourceUrl: 'https://newgensoft.com/investor-relations/financials/',
            sourceType: 'INVESTOR_PRESENTATION',
            page: 12,
            excerpt: 'EBITDA margin recorded at 25.32% for the year.'
          }
        }
      }
    ]
  },

  TCS: {
    companyName: 'Tata Consultancy Services',
    sector: 'IT / Software',
    coverageStart: 'FY2022',
    coverageEnd: 'FY2026',
    facts: [
      {
        period: 'FY2026',
        date: new Date('2026-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY26 Consolidated Revenue Performance',
        fact: 'TCS achieved annual revenue of ₹268,400 Cr in FY26 with PAT of ₹51,200 Cr and operating EBIT margin at 26.2%.',
        metrics: { metric: 'REVENUE', actualValue: 268400, previousValue: 255000, unit: 'INR_CRORE', changePercent: 5.25, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'TCS FY26 Integrated Annual Report', url: 'https://www.tcs.com/investor-relations', publishedAt: new Date('2026-05-14'), pageNumber: 48, excerpt: 'Consolidated revenue for FY26 stood at Rs 268,400 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2026',
        date: new Date('2026-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY26 Net Profit (PAT)',
        fact: 'TCS net profit reached ₹51,200 Cr for FY26 with zero debt.',
        metrics: { metric: 'PAT', actualValue: 51200, previousValue: 48500, unit: 'INR_CRORE', changePercent: 5.57, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'TCS FY26 Financial Statements', url: 'https://www.tcs.com/investor-relations', publishedAt: new Date('2026-05-14'), excerpt: 'Full year net profit reached Rs 51,200 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2026',
        date: new Date('2026-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY26 EBITDA Margin',
        fact: 'Operating EBITDA margin recorded at 28.0% in FY26.',
        metrics: { metric: 'EBITDA_MARGIN', actualValue: 28.0, previousValue: 27.8, unit: 'PERCENTAGE', currency: 'INR' },
        source: { type: 'INVESTOR_PRESENTATION', title: 'TCS Q4 FY26 Earnings Release', url: 'https://www.tcs.com/investor-relations', publishedAt: new Date('2026-04-14'), excerpt: 'EBITDA margin stood at 28.0%.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2025',
        date: new Date('2025-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY25 Consolidated Revenue Milestone',
        fact: 'TCS reported annual revenue of ₹255,000 Cr in FY25 with PAT of ₹48,500 Cr.',
        metrics: { metric: 'REVENUE', actualValue: 255000, previousValue: 240893, unit: 'INR_CRORE', changePercent: 5.86, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'TCS FY25 Annual Report', url: 'https://www.tcs.com/investor-relations', publishedAt: new Date('2025-05-12'), pageNumber: 52, excerpt: 'Consolidated full-year revenue stood at Rs 255,000 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2025',
        date: new Date('2025-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY25 Net Profit (PAT)',
        fact: 'TCS generated ₹48,500 Cr in PAT in FY25.',
        metrics: { metric: 'PAT', actualValue: 48500, previousValue: 45908, unit: 'INR_CRORE', changePercent: 5.65, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'TCS FY25 Annual Report', url: 'https://www.tcs.com', publishedAt: new Date('2025-05-12'), excerpt: 'Net profit was Rs 48,500 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2025',
        date: new Date('2025-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY25 Operating EBITDA Margin',
        fact: 'TCS recorded EBITDA margin of 27.8% in FY25.',
        metrics: { metric: 'EBITDA_MARGIN', actualValue: 27.8, previousValue: 27.2, unit: 'PERCENTAGE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'TCS FY25 Annual Financials', url: 'https://www.tcs.com', publishedAt: new Date('2025-05-12'), excerpt: 'Operating margin recorded at 27.8%.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2024',
        date: new Date('2024-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY24 Revenue of ₹240,893 Cr',
        fact: 'FY24 revenue stood at ₹240,893 Cr (6.8% YoY growth in CC) with Net Profit of ₹45,908 Cr and order book TCV of $42.7 Billion.',
        metrics: { metric: 'REVENUE', actualValue: 240893, previousValue: 225458, unit: 'INR_CRORE', changePercent: 6.85, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'TCS FY24 Integrated Annual Report', url: 'https://www.tcs.com/investor-relations', publishedAt: new Date('2024-05-10'), pageNumber: 44, excerpt: 'Full year revenue reached Rs 240,893 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2024',
        date: new Date('2024-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY24 PAT Performance',
        fact: 'FY24 Net Profit was ₹45,908 Cr.',
        metrics: { metric: 'PAT', actualValue: 45908, previousValue: 42147, unit: 'INR_CRORE', changePercent: 8.92, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'TCS FY24 Annual Report', url: 'https://www.tcs.com', publishedAt: new Date('2024-05-10'), excerpt: 'PAT grew 8.9% YoY to Rs 45,908 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2024',
        date: new Date('2024-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY24 EBITDA Margin',
        fact: 'FY24 EBITDA margin recorded at 27.2%.',
        metrics: { metric: 'EBITDA_MARGIN', actualValue: 27.2, unit: 'PERCENTAGE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'TCS FY24 Financials', url: 'https://www.tcs.com', publishedAt: new Date('2024-05-10'), excerpt: 'Margin stood at 27.2%.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2023',
        date: new Date('2023-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY23 Double-Digit Revenue Expansion',
        fact: 'TCS reported ₹225,458 Cr in revenue for FY23, up 17.58% YoY from ₹191,754 Cr in FY22.',
        metrics: { metric: 'REVENUE', actualValue: 225458, previousValue: 191754, unit: 'INR_CRORE', changePercent: 17.58, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'TCS FY23 Annual Report', url: 'https://www.tcs.com/investor-relations', publishedAt: new Date('2023-05-15'), pageNumber: 38, excerpt: 'Consolidated revenue surpassed Rs 2.25 lakh crore milestone.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2023',
        date: new Date('2023-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY23 PAT Performance',
        fact: 'TCS FY23 Net profit stood at ₹42,147 Cr.',
        metrics: { metric: 'PAT', actualValue: 42147, previousValue: 38327, unit: 'INR_CRORE', changePercent: 9.97, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'TCS FY23 Annual Report', url: 'https://www.tcs.com', publishedAt: new Date('2023-05-15'), excerpt: 'PAT was Rs 42,147 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2023',
        date: new Date('2023-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY23 EBITDA Margin',
        fact: 'FY23 EBITDA margin was 26.8%.',
        metrics: { metric: 'EBITDA_MARGIN', actualValue: 26.8, unit: 'PERCENTAGE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'TCS FY23 Financials', url: 'https://www.tcs.com', publishedAt: new Date('2023-05-15'), excerpt: 'EBITDA margin was 26.8%.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2022',
        date: new Date('2022-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY22 Financial Base',
        fact: 'TCS FY22 revenue was ₹191,754 Cr with PAT of ₹38,327 Cr, EBITDA margin of 27.8%, and zero long-term debt.',
        metrics: { metric: 'REVENUE', actualValue: 191754, unit: 'INR_CRORE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'TCS FY22 Annual Report', url: 'https://www.tcs.com/investor-relations', publishedAt: new Date('2022-05-18'), excerpt: 'FY22 revenue stood at Rs 191,754 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2022',
        date: new Date('2022-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY22 PAT Base',
        fact: 'TCS FY22 PAT was ₹38,327 Cr.',
        metrics: { metric: 'PAT', actualValue: 38327, unit: 'INR_CRORE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'TCS FY22 Annual Report', url: 'https://www.tcs.com', publishedAt: new Date('2022-05-18'), excerpt: 'PAT was Rs 38,327 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2022',
        date: new Date('2022-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY22 EBITDA Margin Base',
        fact: 'TCS FY22 EBITDA margin stood at 27.8%.',
        metrics: { metric: 'EBITDA_MARGIN', actualValue: 27.8, unit: 'PERCENTAGE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'TCS FY22 Annual Report', url: 'https://www.tcs.com', publishedAt: new Date('2022-05-18'), excerpt: 'Margin was 27.8%.' },
        confidence: 0.98, verified: true
      }
    ],
    promises: [
      {
        promiseTitle: 'Operating Margin Band Discipline (26-28%)',
        promiseDescription: 'Management targeted an aspirational EBIT margin band of 26-28% through operational efficiency.',
        financialYear: 'FY25',
        metric: 'EBITDA_MARGIN',
        targetValue: 26.0,
        targetUnit: 'PERCENTAGE',
        targetPeriod: 'FY2025',
        actualValue: 26.0,
        actualUnit: 'PERCENTAGE',
        achievementPercentage: 100,
        status: 'FULFILLED',
        promise: {
          statement: 'Our medium-term aspiration is to defend and operate within the 26-28% EBIT margin corridor.',
          metric: 'EBITDA_MARGIN',
          targetValue: 26.0,
          targetUnit: 'PERCENTAGE',
          targetPeriod: 'FY2025',
          direction: 'HIGHER_IS_BETTER',
          importance: 'HIGH'
        },
        outcome: {
          actualValue: 26.0,
          actualUnit: 'PERCENTAGE',
          outcomePeriod: 'FY2025',
          description: 'EBIT margin reached 26.0% for FY25.'
        },
        verification: {
          status: 'FULFILLED',
          achievementPercentage: 100,
          verifiedAt: new Date('2025-04-12'),
          calculationExplanation: 'Target 26.0%, Actual 26.0% (Matched lower bound of aspirational corridor).'
        },
        evidence: {
          promiseSource: {
            title: 'TCS Investor Presentation FY24',
            sourceUrl: 'https://www.tcs.com/investor-relations',
            sourceType: 'INVESTOR_PRESENTATION',
            excerpt: 'Operating margin aspiration band remains 26-28%.'
          },
          outcomeSource: {
            title: 'TCS Audited FY25 Financials',
            sourceUrl: 'https://www.tcs.com/investor-relations',
            sourceType: 'ANNUAL_REPORT',
            excerpt: 'EBIT margin for FY25 reported at 26.0%.'
          }
        }
      }
    ]
  },

  INFY: {
    companyName: 'Infosys',
    sector: 'IT / Software',
    coverageStart: 'FY2022',
    coverageEnd: 'FY2026',
    facts: [
      {
        period: 'FY2026',
        date: new Date('2026-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY26 Annual Revenue Delivery',
        fact: 'Infosys reported consolidated annual revenue of ₹171,800 Cr in FY26 with operating margin at 21.6% and PAT of ₹29,400 Cr.',
        metrics: { metric: 'REVENUE', actualValue: 171800, previousValue: 162000, unit: 'INR_CRORE', changePercent: 6.05, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Infosys FY26 Annual Report (Form 20-F & Ind AS)', url: 'https://www.infosys.com/investors/reports-filings/annual-report.html', publishedAt: new Date('2026-05-18'), pageNumber: 56, excerpt: 'Consolidated revenue for FY26 reached Rs 171,800 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2026',
        date: new Date('2026-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY26 Net Profit (PAT)',
        fact: 'Net profit for FY26 grew to ₹29,400 Cr with zero long-term debt.',
        metrics: { metric: 'PAT', actualValue: 29400, previousValue: 27800, unit: 'INR_CRORE', changePercent: 5.76, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Infosys FY26 Financial Statements', url: 'https://www.infosys.com/investors', publishedAt: new Date('2026-05-18'), excerpt: 'Full year net profit stood at Rs 29,400 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2026',
        date: new Date('2026-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY26 EBITDA Margin',
        fact: 'Infosys EBITDA margin was 24.5% in FY26.',
        metrics: { metric: 'EBITDA_MARGIN', actualValue: 24.5, previousValue: 24.2, unit: 'PERCENTAGE', currency: 'INR' },
        source: { type: 'INVESTOR_PRESENTATION', title: 'Infosys Q4 FY26 Presentation', url: 'https://www.infosys.com/investors', publishedAt: new Date('2026-04-18'), excerpt: 'EBITDA margin reached 24.5%.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2025',
        date: new Date('2025-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY25 Annual Revenue Delivery',
        fact: 'Infosys reported consolidated annual revenue of ₹162,000 Cr, up 5.42% YoY.',
        metrics: { metric: 'REVENUE', actualValue: 162000, previousValue: 153670, unit: 'INR_CRORE', changePercent: 5.42, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Infosys FY25 Annual Report', url: 'https://www.infosys.com/investors', publishedAt: new Date('2025-05-18'), pageNumber: 56, excerpt: 'Consolidated revenue for FY25 reached Rs 162,000 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2025',
        date: new Date('2025-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY25 Net Profit of ₹27,800 Cr',
        fact: 'Net profit for FY25 grew to ₹27,800 Cr.',
        metrics: { metric: 'PAT', actualValue: 27800, previousValue: 26233, unit: 'INR_CRORE', changePercent: 5.97, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Infosys FY25 Financials', url: 'https://www.infosys.com', publishedAt: new Date('2025-05-18'), excerpt: 'PAT was Rs 27,800 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2025',
        date: new Date('2025-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY25 EBITDA Margin',
        fact: 'EBITDA margin stood at 24.2% in FY25.',
        metrics: { metric: 'EBITDA_MARGIN', actualValue: 24.2, previousValue: 24.0, unit: 'PERCENTAGE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Infosys FY25 Financial Statement', url: 'https://www.infosys.com', publishedAt: new Date('2025-05-18'), excerpt: 'EBITDA margin delivered at 24.2%.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2024',
        date: new Date('2024-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY24 Revenue of ₹153,670 Cr',
        fact: 'Infosys recorded revenue of ₹153,670 Cr in FY24 (1.4% CC growth) with Large Deal TCV of $17.7 Billion.',
        metrics: { metric: 'REVENUE', actualValue: 153670, previousValue: 146767, unit: 'INR_CRORE', changePercent: 4.70, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Infosys FY24 Integrated Annual Report', url: 'https://www.infosys.com/investors', publishedAt: new Date('2024-05-22'), pageNumber: 42, excerpt: 'Revenue was Rs 153,670 Cr with $17.7B large deal wins.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2024',
        date: new Date('2024-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY24 PAT Performance',
        fact: 'FY24 PAT stood at ₹26,233 Cr (up 8.87% YoY).',
        metrics: { metric: 'PAT', actualValue: 26233, previousValue: 24095, unit: 'INR_CRORE', changePercent: 8.87, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Infosys FY24 Financials', url: 'https://www.infosys.com', publishedAt: new Date('2024-05-22'), excerpt: 'PAT was Rs 26,233 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2024',
        date: new Date('2024-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY24 EBITDA Margin',
        fact: 'FY24 EBITDA margin stood at 24.0%.',
        metrics: { metric: 'EBITDA_MARGIN', actualValue: 24.0, unit: 'PERCENTAGE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Infosys FY24 Financials', url: 'https://www.infosys.com', publishedAt: new Date('2024-05-22'), excerpt: 'Margin was 24.0%.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2023',
        date: new Date('2023-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY23 Constant Currency Growth (15.4%)',
        fact: 'Infosys delivered 15.4% CC revenue growth in FY23, achieving revenue of ₹146,767 Cr and PAT of ₹24,095 Cr.',
        metrics: { metric: 'REVENUE', actualValue: 146767, previousValue: 121641, unit: 'INR_CRORE', changePercent: 20.66, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Infosys FY23 Annual Report', url: 'https://www.infosys.com/investors', publishedAt: new Date('2023-05-25'), pageNumber: 36, excerpt: 'Constant currency growth for FY23 was 15.4%.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2023',
        date: new Date('2023-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY23 PAT Performance',
        fact: 'FY23 PAT reached ₹24,095 Cr.',
        metrics: { metric: 'PAT', actualValue: 24095, previousValue: 22110, unit: 'INR_CRORE', changePercent: 8.98, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Infosys FY23 Financials', url: 'https://www.infosys.com', publishedAt: new Date('2023-05-25'), excerpt: 'PAT was Rs 24,095 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2023',
        date: new Date('2023-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY23 EBITDA Margin',
        fact: 'FY23 EBITDA margin was 24.3%.',
        metrics: { metric: 'EBITDA_MARGIN', actualValue: 24.3, unit: 'PERCENTAGE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Infosys FY23 Financials', url: 'https://www.infosys.com', publishedAt: new Date('2023-05-25'), excerpt: 'EBITDA margin was 24.3%.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2022',
        date: new Date('2022-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY22 Financial Base',
        fact: 'Infosys FY22 revenue was ₹121,641 Cr with PAT of ₹22,110 Cr, EBITDA margin of 25.9%, and zero long-term debt.',
        metrics: { metric: 'REVENUE', actualValue: 121641, unit: 'INR_CRORE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Infosys FY22 Annual Report', url: 'https://www.infosys.com/investors', publishedAt: new Date('2022-05-28'), excerpt: 'FY22 revenue was Rs 121,641 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2022',
        date: new Date('2022-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY22 PAT Base',
        fact: 'FY22 PAT stood at ₹22,110 Cr.',
        metrics: { metric: 'PAT', actualValue: 22110, unit: 'INR_CRORE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Infosys FY22 Financials', url: 'https://www.infosys.com', publishedAt: new Date('2022-05-28'), excerpt: 'PAT was Rs 22,110 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2022',
        date: new Date('2022-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY22 EBITDA Margin Base',
        fact: 'FY22 EBITDA margin was 25.9%.',
        metrics: { metric: 'EBITDA_MARGIN', actualValue: 25.9, unit: 'PERCENTAGE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'Infosys FY22 Financials', url: 'https://www.infosys.com', publishedAt: new Date('2022-05-28'), excerpt: 'EBITDA margin stood at 25.9%.' },
        confidence: 0.98, verified: true
      }
    ],
    promises: [
      {
        promiseTitle: 'FY23 Revenue Growth Guidance (14-16% CC)',
        promiseDescription: 'Management guided for 14-16% constant currency revenue growth for FY23.',
        financialYear: 'FY23',
        metric: 'REVENUE_GROWTH',
        targetValue: 14.0,
        targetUnit: 'PERCENTAGE',
        targetPeriod: 'FY2023',
        actualValue: 15.4,
        actualUnit: 'PERCENTAGE',
        achievementPercentage: 110.0,
        status: 'FULFILLED',
        promise: {
          statement: 'We are guiding for full year FY23 revenue growth of 14% to 16% in constant currency.',
          metric: 'REVENUE_GROWTH',
          targetValue: 14.0,
          targetUnit: 'PERCENTAGE',
          targetPeriod: 'FY2023',
          direction: 'HIGHER_IS_BETTER',
          importance: 'HIGH'
        },
        outcome: {
          actualValue: 15.4,
          actualUnit: 'PERCENTAGE',
          outcomePeriod: 'FY2023',
          description: 'FY23 constant currency growth came in at 15.4%.'
        },
        verification: {
          status: 'FULFILLED',
          achievementPercentage: 110.0,
          verifiedAt: new Date('2023-04-13'),
          calculationExplanation: 'Target 14.0%, Actual 15.4% (Achievement = 15.4 / 14.0 * 100 = 110.0%).'
        },
        evidence: {
          promiseSource: {
            title: 'Infosys Q4 FY22 Press Release & Guidance',
            sourceUrl: 'https://www.infosys.com/investors',
            sourceType: 'PRESS_RELEASE',
            excerpt: 'FY23 revenue growth guided at 14%-16% in CC.'
          },
          outcomeSource: {
            title: 'Infosys Q4 FY23 Financial Release',
            sourceUrl: 'https://www.infosys.com/investors',
            sourceType: 'INVESTOR_PRESENTATION',
            page: 10,
            excerpt: 'FY23 constant currency revenue growth delivered at 15.4%.'
          }
        }
      }
    ]
  },

  HDFCBANK: {
    companyName: 'HDFC Bank',
    sector: 'Banking',
    coverageStart: 'FY2022',
    coverageEnd: 'FY2026',
    facts: [
      {
        period: 'FY2026',
        date: new Date('2026-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY26 Consolidated NII & Profit Delivery',
        fact: 'HDFC Bank reported annual Net Interest Income of ₹138,500 Cr and PAT of ₹76,200 Cr in FY26 with gross NPA contained at 1.20%.',
        metrics: { metric: 'REVENUE', actualValue: 138500, previousValue: 124000, unit: 'INR_CRORE', changePercent: 11.69, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'HDFC Bank FY26 Annual Report', url: 'https://www.hdfcbank.com/personal/about-us/investor-relations', publishedAt: new Date('2026-05-20'), pageNumber: 62, excerpt: 'Full year NII reached Rs 138,500 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2026',
        date: new Date('2026-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY26 PAT Milestone',
        fact: 'HDFC Bank PAT rose to ₹76,200 Cr in FY26.',
        metrics: { metric: 'PAT', actualValue: 76200, previousValue: 68500, unit: 'INR_CRORE', changePercent: 11.24, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'HDFC Bank FY26 Financials', url: 'https://www.hdfcbank.com', publishedAt: new Date('2026-05-20'), excerpt: 'PAT was Rs 76,200 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2025',
        date: new Date('2025-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY25 Net Interest Income (NII) Delivery',
        fact: 'HDFC Bank reported annual Net Interest Income of ₹124,000 Cr and PAT of ₹68,500 Cr.',
        metrics: { metric: 'REVENUE', actualValue: 124000, previousValue: 108532, unit: 'INR_CRORE', changePercent: 14.25, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'HDFC Bank FY25 Annual Report', url: 'https://www.hdfcbank.com/personal/about-us/investor-relations', publishedAt: new Date('2025-05-20'), pageNumber: 62, excerpt: 'Full year NII reached Rs 124,000 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2025',
        date: new Date('2025-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY25 PAT Milestone',
        fact: 'HDFC Bank PAT rose to ₹68,500 Cr in FY25.',
        metrics: { metric: 'PAT', actualValue: 68500, previousValue: 60812, unit: 'INR_CRORE', changePercent: 12.64, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'HDFC Bank FY25 Annual Report', url: 'https://www.hdfcbank.com', publishedAt: new Date('2025-05-20'), excerpt: 'Consolidated PAT stood at Rs 68,500 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2024',
        date: new Date('2024-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY24 Post-Merger PAT Surge to ₹60,812 Cr',
        fact: 'HDFC Bank registered NII of ₹108,532 Cr and PAT of ₹60,812 Cr in FY24 (up 37.87% YoY) following completion of the mega-merger with parent HDFC Ltd.',
        metrics: { metric: 'REVENUE', actualValue: 108532, previousValue: 86842, unit: 'INR_CRORE', changePercent: 24.98, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'HDFC Bank FY24 Annual Report', url: 'https://www.hdfcbank.com/personal/about-us/investor-relations', publishedAt: new Date('2024-05-25'), pageNumber: 48, excerpt: 'Net profit for the year rose to Rs 60,812 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2024',
        date: new Date('2024-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY24 PAT Performance',
        fact: 'FY24 PAT stood at ₹60,812 Cr.',
        metrics: { metric: 'PAT', actualValue: 60812, previousValue: 44109, unit: 'INR_CRORE', changePercent: 37.87, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'HDFC Bank FY24 Financials', url: 'https://www.hdfcbank.com', publishedAt: new Date('2024-05-25'), excerpt: 'PAT was Rs 60,812 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2023',
        date: new Date('2023-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY23 Pre-Merger Financial Delivery',
        fact: 'FY23 NII was ₹86,842 Cr (up 20.60% YoY) with PAT of ₹44,109 Cr.',
        metrics: { metric: 'REVENUE', actualValue: 86842, previousValue: 72010, unit: 'INR_CRORE', changePercent: 20.60, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'HDFC Bank FY23 Annual Report', url: 'https://www.hdfcbank.com/personal/about-us/investor-relations', publishedAt: new Date('2023-05-28'), excerpt: 'NII grew 20.6% YoY to Rs 86,842 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2023',
        date: new Date('2023-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY23 PAT Performance',
        fact: 'FY23 Net profit stood at ₹44,109 Cr.',
        metrics: { metric: 'PAT', actualValue: 44109, previousValue: 36961, unit: 'INR_CRORE', changePercent: 19.34, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'HDFC Bank FY23 Financials', url: 'https://www.hdfcbank.com', publishedAt: new Date('2023-05-28'), excerpt: 'PAT was Rs 44,109 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2022',
        date: new Date('2022-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY22 Financial Base',
        fact: 'HDFC Bank FY22 NII stood at ₹72,010 Cr with PAT of ₹36,961 Cr and CASA ratio of 48.2%.',
        metrics: { metric: 'REVENUE', actualValue: 72010, unit: 'INR_CRORE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'HDFC Bank FY22 Annual Report', url: 'https://www.hdfcbank.com', publishedAt: new Date('2022-05-30'), excerpt: 'NII for FY22 was Rs 72,010 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2022',
        date: new Date('2022-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY22 PAT Base',
        fact: 'FY22 PAT was ₹36,961 Cr.',
        metrics: { metric: 'PAT', actualValue: 36961, unit: 'INR_CRORE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'HDFC Bank FY22 Financials', url: 'https://www.hdfcbank.com', publishedAt: new Date('2022-05-30'), excerpt: 'PAT was Rs 36,961 Cr.' },
        confidence: 0.98, verified: true
      }
    ],
    promises: [
      {
        promiseTitle: 'Branch Network Expansion Target (1,500+ Branches)',
        promiseDescription: 'Management targeted adding 1,500 to 2,000 retail branches across semi-urban and rural regions to accelerate deposit mobilization.',
        financialYear: 'FY24',
        metric: 'BRANCH_EXPANSION',
        targetValue: 1500,
        targetUnit: 'COUNT',
        targetPeriod: 'FY2024',
        actualValue: 1650,
        actualUnit: 'COUNT',
        achievementPercentage: 110.0,
        status: 'FULFILLED',
        promise: {
          statement: 'We plan to add 1,500 to 2,000 branches annually over the next few years to deepen geographical distribution.',
          metric: 'BRANCH_EXPANSION',
          targetValue: 1500,
          targetUnit: 'COUNT',
          targetPeriod: 'FY2024',
          direction: 'HIGHER_IS_BETTER',
          importance: 'MEDIUM'
        },
        outcome: {
          actualValue: 1650,
          actualUnit: 'COUNT',
          outcomePeriod: 'FY2024',
          description: 'HDFC Bank opened 1,650 branches during FY24, taking its national footprint to 8,735 branches.'
        },
        verification: {
          status: 'FULFILLED',
          achievementPercentage: 110.0,
          verifiedAt: new Date('2024-04-20'),
          calculationExplanation: 'Target 1,500, Actual 1,650 (Exceeded expansion target).'
        },
        evidence: {
          promiseSource: {
            title: 'HDFC Bank Analyst Day Presentation',
            sourceUrl: 'https://www.hdfcbank.com/personal/about-us/investor-relations',
            sourceType: 'INVESTOR_PRESENTATION',
            excerpt: 'Targeting 1,500+ branch additions per year.'
          },
          outcomeSource: {
            title: 'HDFC Bank Q4 FY24 Investor Presentation',
            sourceUrl: 'https://www.hdfcbank.com/personal/about-us/investor-relations',
            sourceType: 'INVESTOR_PRESENTATION',
            page: 15,
            excerpt: 'Added 1,650 branches in FY24 bringing total network to 8,735.'
          }
        }
      }
    ]
  },

  ICICIBANK: {
    companyName: 'ICICI Bank',
    sector: 'Banking',
    coverageStart: 'FY2022',
    coverageEnd: 'FY2026',
    facts: [
      {
        period: 'FY2026',
        date: new Date('2026-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY26 Consolidated NII & Record Profitability',
        fact: 'ICICI Bank generated Net Interest Income of ₹96,400 Cr and PAT of ₹53,800 Cr in FY26 with gross NPA dropping to 1.88%.',
        metrics: { metric: 'REVENUE', actualValue: 96400, previousValue: 85200, unit: 'INR_CRORE', changePercent: 13.15, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'ICICI Bank FY26 Annual Report & Financials', url: 'https://www.icicibank.com/about-us/investor-relations', publishedAt: new Date('2026-05-18'), pageNumber: 54, excerpt: 'NII for the year expanded to Rs 96,400 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2026',
        date: new Date('2026-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY26 Net Profit Milestone',
        fact: 'ICICI Bank Net profit reached ₹53,800 Cr with ROE at 19.1%.',
        metrics: { metric: 'PAT', actualValue: 53800, previousValue: 47500, unit: 'INR_CRORE', changePercent: 13.26, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'ICICI Bank FY26 Financials', url: 'https://www.icicibank.com', publishedAt: new Date('2026-05-18'), excerpt: 'PAT reached Rs 53,800 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2025',
        date: new Date('2025-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY25 Annual NII & Profitability',
        fact: 'ICICI Bank generated Net Interest Income of ₹85,200 Cr and record PAT of ₹47,500 Cr.',
        metrics: { metric: 'REVENUE', actualValue: 85200, previousValue: 74300, unit: 'INR_CRORE', changePercent: 14.67, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'ICICI Bank FY25 Annual Report & Financials', url: 'https://www.icicibank.com/about-us/investor-relations', publishedAt: new Date('2025-05-18'), pageNumber: 54, excerpt: 'NII for the year expanded to Rs 85,200 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2025',
        date: new Date('2025-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY25 PAT Milestone',
        fact: 'ICICI Bank Net profit rose to ₹47,500 Cr in FY25.',
        metrics: { metric: 'PAT', actualValue: 47500, previousValue: 40888, unit: 'INR_CRORE', changePercent: 16.17, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'ICICI Bank FY25 Financials', url: 'https://www.icicibank.com', publishedAt: new Date('2025-05-18'), excerpt: 'PAT was Rs 47,500 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2024',
        date: new Date('2024-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY24 Strong Profit Surge to ₹40,888 Cr',
        fact: 'PAT grew 28.19% YoY to ₹40,888 Cr in FY24 with NII of ₹74,300 Cr.',
        metrics: { metric: 'REVENUE', actualValue: 74300, previousValue: 62128, unit: 'INR_CRORE', changePercent: 19.59, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'ICICI Bank FY24 Annual Report', url: 'https://www.icicibank.com', publishedAt: new Date('2024-05-22'), pageNumber: 46, excerpt: 'Net profit reached Rs 40,888 Cr in FY24.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2024',
        date: new Date('2024-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY24 PAT Performance',
        fact: 'FY24 PAT was ₹40,888 Cr.',
        metrics: { metric: 'PAT', actualValue: 40888, previousValue: 31896, unit: 'INR_CRORE', changePercent: 28.19, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'ICICI Bank FY24 Financials', url: 'https://www.icicibank.com', publishedAt: new Date('2024-05-22'), excerpt: 'PAT was Rs 40,888 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2023',
        date: new Date('2023-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY23 Exceptional NII Growth (30.9%)',
        fact: 'ICICI Bank delivered NII of ₹62,128 Cr in FY23 (up 30.89% YoY) and PAT of ₹31,896 Cr.',
        metrics: { metric: 'REVENUE', actualValue: 62128, previousValue: 47466, unit: 'INR_CRORE', changePercent: 30.89, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'ICICI Bank FY23 Annual Report', url: 'https://www.icicibank.com', publishedAt: new Date('2023-05-26'), excerpt: 'NII expanded 30.9% YoY to Rs 62,128 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2023',
        date: new Date('2023-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY23 PAT Performance',
        fact: 'FY23 PAT stood at ₹31,896 Cr.',
        metrics: { metric: 'PAT', actualValue: 31896, previousValue: 23339, unit: 'INR_CRORE', changePercent: 36.66, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'ICICI Bank FY23 Financials', url: 'https://www.icicibank.com', publishedAt: new Date('2023-05-26'), excerpt: 'PAT was Rs 31,896 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2022',
        date: new Date('2022-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY22 Financial Base',
        fact: 'FY22 NII was ₹47,466 Cr with PAT of ₹23,339 Cr and GNPA of 3.60%.',
        metrics: { metric: 'REVENUE', actualValue: 47466, unit: 'INR_CRORE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'ICICI Bank FY22 Annual Report', url: 'https://www.icicibank.com', publishedAt: new Date('2022-05-30'), excerpt: 'FY22 NII was Rs 47,466 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2022',
        date: new Date('2022-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY22 PAT Base',
        fact: 'FY22 PAT was ₹23,339 Cr.',
        metrics: { metric: 'PAT', actualValue: 23339, unit: 'INR_CRORE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'ICICI Bank FY22 Financials', url: 'https://www.icicibank.com', publishedAt: new Date('2022-05-30'), excerpt: 'PAT was Rs 23,339 Cr.' },
        confidence: 0.98, verified: true
      }
    ],
    promises: [
      {
        promiseTitle: 'ROE Aspiration of 16-18%',
        promiseDescription: 'Management targeted sustaining consolidated Return on Equity (ROE) within the 16-18% range through risk-calibrated core operating profit growth.',
        financialYear: 'FY24',
        metric: 'ROE',
        targetValue: 16.0,
        targetUnit: 'PERCENTAGE',
        targetPeriod: 'FY2024',
        actualValue: 18.5,
        actualUnit: 'PERCENTAGE',
        achievementPercentage: 115.6,
        status: 'FULFILLED',
        promise: {
          statement: 'Our objective is to deliver risk-calibrated core operating profit and sustain ROE in the 16-18% range.',
          metric: 'ROE',
          targetValue: 16.0,
          targetUnit: 'PERCENTAGE',
          targetPeriod: 'FY2024',
          direction: 'HIGHER_IS_BETTER',
          importance: 'HIGH'
        },
        outcome: {
          actualValue: 18.5,
          actualUnit: 'PERCENTAGE',
          outcomePeriod: 'FY2024',
          description: 'ICICI Bank delivered an ROE of 18.5% in FY24.'
        },
        verification: {
          status: 'FULFILLED',
          achievementPercentage: 115.6,
          verifiedAt: new Date('2024-04-25'),
          calculationExplanation: 'Target 16.0%, Actual 18.5% (Achievement = 18.5 / 16.0 * 100 = 115.6%).'
        },
        evidence: {
          promiseSource: {
            title: 'ICICI Bank Earnings Conference Call FY23',
            sourceUrl: 'https://www.icicibank.com/about-us/investor-relations',
            sourceType: 'EARNINGS_CALL',
            excerpt: 'We aim to sustain ROE in the 16-18% corridor.'
          },
          outcomeSource: {
            title: 'ICICI Bank FY24 Annual Report',
            sourceUrl: 'https://www.icicibank.com',
            sourceType: 'ANNUAL_REPORT',
            page: 46,
            excerpt: 'Return on equity for FY24 stood at 18.5%.'
          }
        }
      }
    ]
  },

  BHEL: {
    companyName: 'Bharat Heavy Electricals',
    sector: 'Capital Goods',
    coverageStart: 'FY2022',
    coverageEnd: 'FY2026',
    facts: [
      {
        period: 'FY2026',
        date: new Date('2026-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY26 Annual Revenue & Order Execution',
        fact: 'BHEL reported annual turnover of ₹32,400 Cr in FY26 with PAT expanding to ₹1,480 Cr and order book holding strong at ₹172,000 Cr.',
        metrics: { metric: 'REVENUE', actualValue: 32400, previousValue: 28500, unit: 'INR_CRORE', changePercent: 13.68, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'BHEL FY26 Annual Report & Financials', url: 'https://www.bhel.com/investor-relations', publishedAt: new Date('2026-05-25'), pageNumber: 38, excerpt: 'Turnover for FY26 stood at Rs 32,400 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2026',
        date: new Date('2026-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY26 PAT Turnaround Growth',
        fact: 'BHEL Net Profit expanded to ₹1,480 Cr in FY26.',
        metrics: { metric: 'PAT', actualValue: 1480, previousValue: 1050, unit: 'INR_CRORE', changePercent: 40.95, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'BHEL FY26 Financial Statements', url: 'https://www.bhel.com', publishedAt: new Date('2026-05-25'), excerpt: 'Net profit reached Rs 1,480 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2025',
        date: new Date('2025-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY25 Annual Revenue Delivery',
        fact: 'BHEL reported annual revenue of ₹28,500 Cr, up 19.28% YoY.',
        metrics: { metric: 'REVENUE', actualValue: 28500, previousValue: 23893, unit: 'INR_CRORE', changePercent: 19.28, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'BHEL FY25 Annual Report', url: 'https://www.bhel.com/investor-relations', publishedAt: new Date('2025-05-25'), pageNumber: 38, excerpt: 'Turnover for FY25 stood at Rs 28,500 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2025',
        date: new Date('2025-03-31'),
        category: 'ORDER_BOOK',
        title: 'Order Book Surges to Historic ₹160,000 Cr Landmark',
        fact: 'Total order book reached ₹160,000 Cr backed by thermal power plant equipment orders from NTPC, Adani Power, and Indian Railways.',
        metrics: { metric: 'ORDER_BOOK', actualValue: 160000, previousValue: 135000, unit: 'INR_CRORE', changePercent: 18.52, currency: 'INR' },
        source: { type: 'INVESTOR_PRESENTATION', title: 'BHEL FY25 Q4 Order Book Presentation', url: 'https://www.bhel.com/investor-relations', publishedAt: new Date('2025-05-20'), pageNumber: 7, excerpt: 'Outstanding order book stood at Rs 160,000 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2025',
        date: new Date('2025-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY25 PAT Turnaround',
        fact: 'BHEL net profit turned around to ₹1,050 Cr in FY25.',
        metrics: { metric: 'PAT', actualValue: 1050, previousValue: 282, unit: 'INR_CRORE', changePercent: 272.34, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'BHEL FY25 Financial Statement', url: 'https://www.bhel.com', publishedAt: new Date('2025-05-25'), excerpt: 'Net profit reached Rs 1,050 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2024',
        date: new Date('2024-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY24 Revenue & Order Inflow Surge',
        fact: 'FY24 revenue was ₹23,893 Cr with record order inflows of ₹77,900 Cr during the year.',
        metrics: { metric: 'REVENUE', actualValue: 23893, previousValue: 23365, unit: 'INR_CRORE', changePercent: 2.26, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'BHEL FY24 Annual Report', url: 'https://www.bhel.com', publishedAt: new Date('2024-05-28'), pageNumber: 32, excerpt: 'Revenue stood at Rs 23,893 Cr with order inflows of Rs 77,900 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2024',
        date: new Date('2024-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY24 PAT Performance',
        fact: 'FY24 PAT was ₹282 Cr.',
        metrics: { metric: 'PAT', actualValue: 282, previousValue: 448, unit: 'INR_CRORE', changePercent: -37.05, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'BHEL FY24 Financials', url: 'https://www.bhel.com', publishedAt: new Date('2024-05-28'), excerpt: 'PAT stood at Rs 282 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2023',
        date: new Date('2023-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY23 Financial Delivery',
        fact: 'BHEL delivered revenue of ₹23,365 Cr in FY23 (up 10.15% YoY from ₹21,211 Cr in FY22) with PAT of ₹448 Cr.',
        metrics: { metric: 'REVENUE', actualValue: 23365, previousValue: 21211, unit: 'INR_CRORE', changePercent: 10.15, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'BHEL FY23 Annual Report', url: 'https://www.bhel.com', publishedAt: new Date('2023-05-30'), excerpt: 'FY23 turnover stood at Rs 23,365 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2023',
        date: new Date('2023-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY23 PAT Base',
        fact: 'FY23 PAT was ₹448 Cr compared to ₹410 Cr in FY22.',
        metrics: { metric: 'PAT', actualValue: 448, previousValue: 410, unit: 'INR_CRORE', changePercent: 9.27, currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'BHEL FY23 Annual Report', url: 'https://www.bhel.com', publishedAt: new Date('2023-05-30'), excerpt: 'PAT was Rs 448 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2022',
        date: new Date('2022-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY22 Financial Base',
        fact: 'BHEL FY22 revenue was ₹21,211 Cr with PAT of ₹410 Cr and order book of ₹102,542 Cr.',
        metrics: { metric: 'REVENUE', actualValue: 21211, unit: 'INR_CRORE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'BHEL FY22 Annual Report', url: 'https://www.bhel.com', publishedAt: new Date('2022-05-30'), excerpt: 'FY22 turnover was Rs 21,211 Cr with PAT of Rs 410 Cr.' },
        confidence: 0.98, verified: true
      },
      {
        period: 'FY2022',
        date: new Date('2022-03-31'),
        category: 'FINANCIAL_PERFORMANCE',
        title: 'FY22 PAT Base',
        fact: 'FY22 PAT stood at ₹410 Cr.',
        metrics: { metric: 'PAT', actualValue: 410, unit: 'INR_CRORE', currency: 'INR' },
        source: { type: 'ANNUAL_REPORT', title: 'BHEL FY22 Financials', url: 'https://www.bhel.com', publishedAt: new Date('2022-05-30'), excerpt: 'PAT was Rs 410 Cr.' },
        confidence: 0.98, verified: true
      }
    ],
    promises: [
      {
        promiseTitle: 'Thermal Equipment Market Share Defense (>60%)',
        promiseDescription: 'Management targeted capturing over 60% market share in newly tendered super-critical thermal power equipment in India.',
        financialYear: 'FY25',
        metric: 'MARKET_SHARE',
        targetValue: 60.0,
        targetUnit: 'PERCENTAGE',
        targetPeriod: 'FY2025',
        actualValue: 78.0,
        actualUnit: 'PERCENTAGE',
        achievementPercentage: 130.0,
        status: 'FULFILLED',
        promise: {
          statement: 'We intend to retain our dominance by winning >60% of upcoming super-critical thermal power equipment bids.',
          metric: 'MARKET_SHARE',
          targetValue: 60.0,
          targetUnit: 'PERCENTAGE',
          targetPeriod: 'FY2025',
          direction: 'HIGHER_IS_BETTER',
          importance: 'HIGH'
        },
        outcome: {
          actualValue: 78.0,
          actualUnit: 'PERCENTAGE',
          outcomePeriod: 'FY2025',
          description: 'BHEL won over 78% of all thermal BTG contracts tendered by NTPC, DVC, and private utilities in FY24-FY25.'
        },
        verification: {
          status: 'FULFILLED',
          achievementPercentage: 130.0,
          verifiedAt: new Date('2025-05-20'),
          calculationExplanation: 'Target 60.0%, Actual 78.0% (Achievement = 78.0 / 60.0 * 100 = 130.0%).'
        },
        evidence: {
          promiseSource: {
            title: 'BHEL Management Investor Meet Commentary',
            sourceUrl: 'https://www.bhel.com/investor-relations',
            sourceType: 'INVESTOR_PRESENTATION',
            excerpt: 'Targeting >60% market share in new thermal capacity additions.'
          },
          outcomeSource: {
            title: 'BHEL Q4 FY25 Order Book Disclosure',
            sourceUrl: 'https://www.bhel.com',
            sourceType: 'INVESTOR_PRESENTATION',
            page: 8,
            excerpt: 'Captured 78% market share in thermal BTG orders awarded in FY25.'
          }
        }
      }
    ]
  }
};

export const seedHistoricalIntelligence = async () => {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(mongoUri);
  }

  logger.info('Starting Verified Historical Intelligence seeding for Enterprise Stocks (FY2022–FY2026)...');

  for (const [symbol, data] of Object.entries(SEED_DATA)) {
    // Legacy seed records predate provenance. Mark them as demo before writing
    // the current seed shape so research queries cannot treat them as real.
    await CompanyHistoricalFact.updateMany(
      { symbol, dataOrigin: { $exists: false } },
      { $set: { dataOrigin: 'SEEDED_DEMO' } },
    );
    await ManagementPromise.updateMany(
      { symbol, dataOrigin: { $exists: false } },
      { $set: { dataOrigin: 'SEEDED_DEMO' } },
    );
    await ResearchRun.updateMany(
      { companySymbol: symbol, dataOrigin: { $exists: false } },
      { $set: { dataOrigin: 'SEEDED_DEMO' } },
    );

    // 1. Create or Update ResearchRun
    const researchRun = await ResearchRun.findOneAndUpdate(
      { companySymbol: symbol, dataOrigin: 'SEEDED_DEMO' },
      {
        dataOrigin: 'SEEDED_DEMO',
        companySymbol: symbol,
        status: 'COMPLETED',
        coverageStart: data.coverageStart,
        coverageEnd: data.coverageEnd,
        factsExtracted: data.facts.length,
        factsVerified: data.facts.length,
        promisesFound: data.promises.length,
        promisesVerified: data.promises.length,
        sourcesFound: data.facts.length + data.promises.length,
        sourceStats: {
          documentsFound: data.facts.length + data.promises.length,
          annualReportsFound: 5,
          presentationsFound: 4,
          filingsFound: 3
        },
        completedAt: new Date()
      },
      { upsert: true, new: true }
    );

    // 2. Upsert Facts
    for (const fact of data.facts) {
      await CompanyHistoricalFact.updateOne(
        {
          symbol,
          period: fact.period,
          title: fact.title
        },
        {
          ...fact,
          dataOrigin: 'SEEDED_DEMO',
          symbol,
          companyName: data.companyName,
          researchRunId: researchRun._id
        },
        { upsert: true }
      );
    }

    // 3. Upsert Promises
    for (const promise of data.promises) {
      await ManagementPromise.updateOne(
        {
          symbol,
          financialYear: promise.financialYear,
          promiseTitle: promise.promiseTitle
        },
        {
          ...promise,
          dataOrigin: 'SEEDED_DEMO',
          symbol,
          companyName: data.companyName,
          researchRunId: researchRun._id
        },
        { upsert: true }
      );
    }

    logger.info(`✓ Seeded ${data.facts.length} facts & ${data.promises.length} verified guidance targets for ${symbol} (${data.companyName})`);
  }

  logger.info('Seeding completed successfully.');
};

// If run directly via node
if (process.argv[1]?.endsWith('seedHistoricalIntelligence.js')) {
  seedHistoricalIntelligence().then(() => {
    console.log('Seeding finished.');
    process.exit(0);
  }).catch((err) => {
    console.error('Seeding error:', err);
    process.exit(1);
  });
}
