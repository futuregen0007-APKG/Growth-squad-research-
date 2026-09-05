import test from 'node:test';
import assert from 'node:assert/strict';
import PortfolioHolding from '../models/PortfolioHolding.js';

test('portfolio holdings require a user owner and unique symbols per user', () => {
  assert.equal(PortfolioHolding.schema.path('userId').isRequired, true);
  assert.ok(PortfolioHolding.schema.indexes().some(([fields, options]) => (
    fields.userId === 1 && fields.symbol === 1 && options.unique === true
  )));
});

test('portfolio holding validation rejects zero quantity', () => {
  const holding = new PortfolioHolding({
    userId: '507f1f77bcf86cd799439011',
    symbol: 'HAL',
    quantity: 0,
    averageBuyPrice: 100,
  });
  const error = holding.validateSync();
  assert.ok(error?.errors.quantity);
});