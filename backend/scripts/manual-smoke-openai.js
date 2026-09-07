/**
 * MANUAL-SMOKE-OPENAI.JS
 * ========================
 * ⚠️  CONSUMES A SMALL AMOUNT OF REAL OPENAI CREDIT. NOT RUN AUTOMATICALLY.
 * Not part of `npm test` / CI. Run this yourself, deliberately, to confirm
 * OPENAI_API_KEY / OPENAI_CHAT_MODEL actually work against your real
 * account — the smallest possible real call (a two-word streamed
 * completion), never printing the API key.
 *
 * USAGE:
 *   node scripts/manual-smoke-openai.js
 */
import dotenv from 'dotenv';
dotenv.config();

import { OpenAIClientFactory, LLM_CONFIG } from '../llm/OpenAIClientFactory.js';
import { mapOpenAIError } from '../llm/errors.js';

const run = async () => {
  if (!OpenAIClientFactory.isConfigured()) {
    console.error('OPENAI_API_KEY is not set in backend/.env — cannot run the smoke test.');
    process.exit(1);
  }

  console.log(`\n⚠️  This will make one small real request to OpenAI (model: ${LLM_CONFIG.chatModel}) and consume a small amount of credit.`);
  console.log('Press Ctrl+C within 3 seconds to cancel...\n');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  try {
    const client = OpenAIClientFactory.getClient();
    const stream = await client.chat.completions.create({
      model: LLM_CONFIG.chatModel,
      temperature: 0,
      max_tokens: 10,
      stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly the two words: smoke test.' }],
    });

    let text = '';
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) text += delta;
    }

    console.log(`✅ OpenAI streaming call succeeded. Model replied: "${text.trim()}"`);
    console.log(`Model used: ${LLM_CONFIG.chatModel}`);
  } catch (error) {
    const mapped = mapOpenAIError(error, { operation: 'manual smoke test' });
    console.error(`\n❌ Smoke test failed: [${mapped.errorCode || 'ERROR'}] ${mapped.message}`);
    process.exitCode = 1;
  }
};

run();
