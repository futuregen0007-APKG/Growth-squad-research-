import mongoose from 'mongoose';

const managementPromiseSchema = new mongoose.Schema({
  companyId: { type: String, required: true, trim: true },
  symbol: { type: String, required: true, uppercase: true, trim: true, index: true },
  companyName: { type: String, required: true, trim: true },
  
  // Promise details
  promise: {
    statement: { type: String, required: true },
    metric: { 
      type: String, 
      required: true, 
      enum: [
        'REVENUE', 'REVENUE_GROWTH', 'EBITDA', 'EBITDA_MARGIN', 'PAT', 'PAT_GROWTH',
        'ORDER_BOOK', 'ORDER_INTAKE', 'ARR', 'BOOKINGS', 'CAPEX', 'DEBT', 'DEBT_REDUCTION',
        'MARGIN', 'MARKET_SHARE', 'CUSTOMER_COUNT', 'EMPLOYEE_COUNT', 'FREE_CASH_FLOW',
        'LARGE_DEALS', 'EXPORT_REVENUE', 'OTHER_QUANTIFIABLE', 'OTHER'
      ] 
    },
    targetValue: { type: Number, required: true },
    targetUnit: { type: String, required: true, enum: ['INR_CRORE', 'INR_LAKH', 'USD_MILLION', 'USD_BILLION', 'PERCENTAGE', 'COUNT', 'OTHER'] },
    targetPeriod: { type: String, required: true }, // e.g., "FY2026", "Q4 FY2025"
    promiseDate: { type: Date, required: true },
    direction: { type: String, required: true, enum: ['HIGHER_IS_BETTER', 'LOWER_IS_BETTER', 'TARGET_RANGE'] },
    importance: { type: String, required: true, enum: ['HIGH', 'MEDIUM', 'LOW'] }
  },
  
  // Outcome details
  outcome: {
    actualValue: { type: Number, default: null },
    actualUnit: { type: String, default: null },
    actualPeriod: { type: String, default: null },
    statement: { type: String, default: null },
    sourceUrl: { type: String, default: null },
    sourceDate: { type: Date, default: null },
    excerpt: { type: String, default: null }
  },
  
  // Verification details
  verification: {
    achievementPercentage: { type: Number, default: null },
    status: { type: String, enum: ['FULFILLED', 'PARTIALLY_FULFILLED', 'MISSED', 'PENDING', 'INSUFFICIENT_EVIDENCE'], default: 'INSUFFICIENT_EVIDENCE' },
    calculationExplanation: { type: String, default: null },
    confidence: { type: Number, default: null, min: 0, max: 1 }
  },
  
  // Explanation details
  explanation: {
    managementExplanation: { type: String, default: null },
    category: { 
      type: String, 
      enum: [
        'DEMAND_WEAKNESS', 'EXECUTION_DELAY', 'CUSTOMER_DELAY', 'MACROECONOMIC', 
        'REGULATORY', 'COMPETITIVE_PRESSURE', 'COMPETITION', 'CURRENCY', 'ACQUISITION', 
        'ONE_OFF', 'CAPACITY_CONSTRAINT', 'MANAGEMENT_REVISED_GUIDANCE', 'PROJECT_DELAY', 
        'INTERNAL_EXECUTION', 'TIMING', 'UNSPECIFIED', 'OTHER', 'NO_EXPLANATION_FOUND'
      ], 
      default: 'NO_EXPLANATION_FOUND' 
    },
    sourceUrl: { type: String, default: null },
    sourceDate: { type: Date, default: null },
    excerpt: { type: String, default: null }
  },
  
  // Evidence sources
  evidence: {
    promiseSource: {
      sourceType: { type: String, default: null },
      sourceName: { type: String, default: null },
      sourceUrl: { type: String, required: true },
      sourceDate: { type: Date, required: true },
      publicationDate: { type: Date, default: null },
      title: { type: String, required: true },
      excerpt: { type: String, required: true },
      documentType: { type: String, default: null },
      authorityLevel: { type: Number, default: null }
    },
    outcomeSource: {
      sourceType: { type: String, default: null },
      sourceName: { type: String, default: null },
      sourceUrl: { type: String, default: null },
      sourceDate: { type: Date, default: null },
      publicationDate: { type: Date, default: null },
      title: { type: String, default: null },
      excerpt: { type: String, default: null },
      documentType: { type: String, default: null },
      authorityLevel: { type: Number, default: null }
    },
    explanationSource: {
      sourceType: { type: String, default: null },
      sourceName: { type: String, default: null },
      sourceUrl: { type: String, default: null },
      sourceDate: { type: Date, default: null },
      publicationDate: { type: Date, default: null },
      title: { type: String, default: null },
      excerpt: { type: String, default: null },
      documentType: { type: String, default: null },
      authorityLevel: { type: Number, default: null }
    }
  },
  
  // Research linkage
  researchRunId: { type: mongoose.Schema.Types.ObjectId, ref: 'ResearchRun', default: null },
  
  // Legacy fields for backward compatibility (deprecated)
  exchange: { type: String, default: null },
  financialYear: { type: String, default: null },
  period: { type: String, default: null },
  promiseTitle: { type: String, default: null },
  promiseText: { type: String, default: null },
  promiseDescription: { type: String, default: null },
  promiseType: { type: String, default: null },
  metric: { type: String, default: null },
  metricType: { type: String, default: null },
  targetValue: { type: Number, default: null },
  targetUnit: { type: String, default: null },
  targetPeriod: { type: String, default: null },
  guidanceDate: { type: Date, default: null },
  announcementDate: { type: Date, default: null },
  actualValue: { type: Number, default: null },
  actualUnit: { type: String, default: null },
  actualPeriod: { type: String, default: null },
  actualDate: { type: Date, default: null },
  actualSourceUrl: { type: String, default: null },
  actualSourceTitle: { type: String, default: null },
  actualSourceDate: { type: Date, default: null },
  actualSourceExcerpt: { type: String, default: null },
  achievementPercentage: { type: Number, default: null },
  calculationExplanation: { type: String, default: null },
  status: { type: String, enum: ['FULFILLED', 'PARTIALLY_FULFILLED', 'MISSED', 'PENDING', 'INSUFFICIENT_EVIDENCE'], default: 'INSUFFICIENT_EVIDENCE' },
  importance: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW'], default: 'MEDIUM' },
  sourceType: { type: String, default: null },
  sourceTitle: { type: String, default: null },
  sourceUrl: { type: String, default: null },
  sourceDate: { type: Date, default: null },
  sourceExcerpt: { type: String, default: null },
  confidenceScore: { type: Number, default: null },
  confidence: { type: Number, default: null },
  managementExplanation: { type: String, default: null },
  managementReason: { type: String, default: null },
  reasonType: { type: String, default: null },
  reasonSourceUrl: { type: String, default: null },
  reasonSourceExcerpt: { type: String, default: null },
  aiAnalysis: { type: mongoose.Schema.Types.Mixed, default: null }
}, { timestamps: true });

// Indexes for efficient queries
managementPromiseSchema.index({ symbol: 1, 'promise.targetPeriod': -1 });
managementPromiseSchema.index({ symbol: 1, 'verification.status': 1 });
managementPromiseSchema.index({ researchRunId: 1 });

export default mongoose.models.ManagementPromise || mongoose.model('ManagementPromise', managementPromiseSchema);
