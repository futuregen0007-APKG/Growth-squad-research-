import mongoose from 'mongoose';

export const FACT_CATEGORIES = [
  'FINANCIAL_PERFORMANCE',
  'OPERATIONAL_PERFORMANCE',
  'MANAGEMENT_COMMENTARY',
  'STRATEGY',
  'ORDER_BOOK',
  'CONTRACT',
  'PRODUCT',
  'EXPANSION',
  'ACQUISITION',
  'CAPEX',
  'EARNINGS',
  'CORPORATE_ACTION',
  'RISK',
  'GUIDANCE',
  'OTHER'
];

export const SOURCE_TYPES = [
  'ANNUAL_REPORT',
  'QUARTERLY_REPORT',
  'INVESTOR_PRESENTATION',
  'EARNINGS_CALL_TRANSCRIPT',
  'EXCHANGE_FILING',
  'PRESS_RELEASE',
  'MANAGEMENT_INTERVIEW',
  'INVESTOR_RELATIONS',
  'FINANCIAL_PUBLICATION',
  'NEWS_ARTICLE',
  'OTHER'
];

const companyHistoricalFactSchema = new mongoose.Schema({
  symbol: { 
    type: String, 
    required: true, 
    uppercase: true, 
    index: true 
  },
  companyName: { 
    type: String, 
    required: true 
  },

  date: { 
    type: Date, 
    required: true, 
    index: true 
  },
  period: { 
    type: String, 
    required: true,
    index: true 
  }, // e.g., 'FY2025', 'FY2026 Q1', 'Q3 FY24'

  category: { 
    type: String, 
    enum: FACT_CATEGORIES, 
    required: true, 
    index: true 
  },

  title: { 
    type: String, 
    required: true 
  },
  fact: { 
    type: String, 
    required: true 
  },
  summary: { 
    type: String, 
    default: null 
  },

  metrics: {
    metric: { type: String, default: null }, // e.g. 'REVENUE', 'EBITDA_MARGIN', 'PAT', 'ORDER_BOOK', 'DEBT'
    actualValue: { type: Number, default: null },
    previousValue: { type: Number, default: null },
    unit: { type: String, default: 'INR_CRORE' }, // e.g. 'INR_CRORE', 'PERCENTAGE', 'COUNT', 'USD_MILLION'
    changePercent: { type: Number, default: null },
    currency: { type: String, default: 'INR' }
  },

  source: {
    type: { 
      type: String, 
      enum: SOURCE_TYPES, 
      default: 'NEWS_ARTICLE' 
    },
    title: { type: String, required: true },
    url: { type: String, required: true },
    publishedAt: { type: Date, default: Date.now },
    pageNumber: { type: mongoose.Schema.Types.Mixed, default: null },
    excerpt: { type: String, required: true }
  },

  confidence: { 
    type: Number, 
    default: 0.85,
    min: 0,
    max: 1.0
  },
  verified: { 
    type: Boolean, 
    default: true 
  },

  isNegative: {
    type: Boolean,
    default: false
  },

  researchRunId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'ResearchRun', 
    default: null 
  }
}, { 
  timestamps: true 
});

// Composite index for fast company timeline queries
companyHistoricalFactSchema.index({ symbol: 1, date: -1 });
companyHistoricalFactSchema.index({ symbol: 1, category: 1 });
companyHistoricalFactSchema.index({ symbol: 1, period: 1 });

export default mongoose.models.CompanyHistoricalFact || mongoose.model('CompanyHistoricalFact', companyHistoricalFactSchema);
