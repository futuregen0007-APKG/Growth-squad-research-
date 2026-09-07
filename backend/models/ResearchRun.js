import mongoose from 'mongoose';

const researchRunSchema = new mongoose.Schema({
  dataOrigin: {
    type: String,
    enum: ['REAL_RESEARCH', 'SEEDED_DEMO'],
    default: 'REAL_RESEARCH',
    index: true,
  },
  companySymbol: { type: String, required: true, uppercase: true, index: true },
  startedAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null },
  duration: { type: Number, default: null }, // in milliseconds
  status: { type: String, enum: ['RUNNING', 'COMPLETED', 'FAILED'], default: 'RUNNING', index: true },
  state: { 
    type: String, 
    enum: [
      'RESEARCH_REQUIRED', 
      'RESEARCH_RUNNING', 
      'VERIFIED_DATA_AVAILABLE', 
      'HISTORICAL_DATA_AVAILABLE',
      'INSUFFICIENT_EVIDENCE', 
      'LIMITED_COVERAGE',
      'DATABASE_ERROR', 
      'API_ERROR', 
      'RESEARCH_FAILED'
    ], 
    default: 'RESEARCH_RUNNING' 
  },
  progressStep: { type: String, default: null },
  progressMessage: { type: String, default: null },

  // Historical coverage & extraction telemetry
  coverageStart: { type: String, default: null }, // e.g. 'FY2022'
  coverageEnd: { type: String, default: null },   // e.g. 'FY2026'
  factsExtracted: { type: Number, default: 0 },
  factsVerified: { type: Number, default: 0 },
  promisesFound: { type: Number, default: 0 },
  promisesVerified: { type: Number, default: 0 },
  executionScore: { type: Number, default: null },
  confidenceLevel: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW', null], default: null },
  
  // Source statistics
  sourceStats: {
    documentsFound: { type: Number, default: 0 },
    officialDocuments: { type: Number, default: 0 },
    exchangeDocuments: { type: Number, default: 0 },
    newsDocuments: { type: Number, default: 0 },
    pdfDocuments: { type: Number, default: 0 }
  },
  
  // Extraction statistics
  extractionStats: {
    documentsAnalyzed: { type: Number, default: 0 },
    factsExtracted: { type: Number, default: 0 },
    factsVerified: { type: Number, default: 0 },
    candidatePromises: { type: Number, default: 0 },
    verifiedPromises: { type: Number, default: 0 },
    outcomesFound: { type: Number, default: 0 },
    explanationsFound: { type: Number, default: 0 }
  },
  
  // Provider statistics
  providerStats: [{
    provider: { type: String, required: true },
    status: { type: String, enum: ['SUCCESS', 'FAILED', 'PARTIAL'], required: true },
    documentsFound: { type: Number, default: 0 },
    error: { type: String, default: null }
  }],
  
  // Document collection debug information
  documentCollectionDebug: {
    urlsAttempted: [{ type: String }],
    urlsSuccessfullyRetrieved: [{ type: String }],
    failedUrls: [{
      url: { type: String },
      code: { type: String },
      reason: { type: String },
      severity: { type: String },
      tlsDetails: mongoose.Schema.Types.Mixed
    }],
    documentsDiscovered: [{ type: String }],
    linksDiscovered: { type: Number, default: 0 },
    pdfsDiscovered: [{ type: String }],
    pdfsSuccessfullyExtracted: [{ type: String }],
    rejectedDocuments: [{
      url: { type: String },
      reason: { type: String },
      contentLength: { type: Number }
    }],
    countsByProvider: mongoose.Schema.Types.Mixed,
    tlsSummary: {
      totalTlsErrors: { type: Number, default: 0 },
      uniqueUrlsWithTlsErrors: [{ type: String }]
    },
    stats: mongoose.Schema.Types.Mixed
  },
  
  // Rejection reasons for debugging
  rejectionReasons: [{ type: String }],
  
  error: { type: String, default: null }
}, { timestamps: true });

// Calculate duration before saving
researchRunSchema.pre('save', function(next) {
  if (this.completedAt && this.startedAt && !this.duration) {
    this.duration = this.completedAt - this.startedAt;
  }
  next();
});

export default mongoose.models.ResearchRun || mongoose.model('ResearchRun', researchRunSchema);
