/**
 * fixChatMessageClientIdIndex.js
 * =================================
 * UI Phase 1D one-time migration. A confirmed, severe live bug: the
 * chatmessages collection's unique index on {threadId, clientMessageId}
 * was declared `sparse: true`, but models/ChatMessage.js's OLD field
 * definition (`clientMessageId: { type: String, default: null, ... }`)
 * meant the field was ALWAYS present with value `null` on every assistant
 * message (a sparse index only skips a field that is genuinely MISSING,
 * never one explicitly set to null) -- so the SECOND assistant message
 * ever saved to any thread collided with the first on this index, and
 * every assistant reply after the first was silently dropped
 * (saveMemory.js's own try/catch only warns, never surfaces this to the
 * user or fails the turn). Confirmed via a real 6-turn browser session:
 * only the first assistant reply survived a reload.
 *
 * The model now declares clientMessageId with no default (genuinely
 * absent when not supplied) and a PARTIAL index (not sparse) scoped to
 * `clientMessageId: {$type: 'string'}`. Mongoose does not retroactively
 * rebuild an already-existing index with different options when the
 * schema changes underneath it -- this script drops the old index by
 * name and lets the driver recreate the corrected one from the current
 * schema, once, against the real configured database.
 *
 *   node scripts/fixChatMessageClientIdIndex.js
 *
 * Safe to run more than once (a no-op if the index is already correct).
 * Never touches any document's data -- index-only.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

const { default: ChatMessage } = await import('../models/ChatMessage.js');

await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
console.log('Connected to MongoDB.');

const collection = ChatMessage.collection;
const before = await collection.indexes();
console.log('Indexes BEFORE:', JSON.stringify(before, null, 2));

const staleIndex = before.find((ix) => (
  JSON.stringify(ix.key) === JSON.stringify({ threadId: 1, clientMessageId: 1 }) && !ix.partialFilterExpression
));

if (staleIndex) {
  console.log(`Dropping stale index "${staleIndex.name}" (sparse, not partial)...`);
  await collection.dropIndex(staleIndex.name);
  console.log('Dropped.');
} else {
  console.log('No stale sparse-only {threadId, clientMessageId} index found -- nothing to drop.');
}

console.log('Syncing indexes from the current schema...');
await ChatMessage.syncIndexes();

const after = await collection.indexes();
console.log('Indexes AFTER:', JSON.stringify(after, null, 2));

const fixed = after.find((ix) => ix.name === 'unique_client_message_id_per_thread');
console.log('\nRESULT:', fixed ? 'Corrected partial index is now in place.' : 'FAILED -- corrected index not found after sync.');

await mongoose.disconnect();
process.exit(fixed ? 0 : 1);
