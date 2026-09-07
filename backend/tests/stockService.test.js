import test from 'node:test';
import assert from 'node:assert/strict';
import { StockService } from '../services/StockService.js';

test('provider outages do not produce fabricated stock records', async () => {
  const service = new StockService({
    getMultipleStocks: async () => [],
  });

  const result = await service.getMultipleStocks(['HAL']);

  assert.deepEqual(result, []);
});