const IST_TIME_ZONE = 'Asia/Kolkata';
const MARKET_OPEN_MINUTES = 9 * 60 + 15; // 09:15 IST
const MARKET_CLOSE_MINUTES = 15 * 60 + 30; // 15:30 IST

/**
 * getIstMarketStatus - Shared NSE/BSE market-status calculation used by every
 * market-data provider, so the open/closed rule lives in one place.
 *
 * Accepts an injectable reference date (defaults to the real clock) so tests
 * can assert deterministic outcomes instead of depending on when they run.
 *
 * Does not account for exchange holidays - see backend/utils/marketStatus.js
 * usage sites for the tracked follow-up.
 *
 * @param {Date} [now] - Reference instant to evaluate
 * @returns {{isOpen: boolean, region: string, session: string, closesAt: string, serverTime: string}}
 */
export const getIstMarketStatus = (now = new Date()) => {
  const istTime = new Date(now.toLocaleString('en-US', { timeZone: IST_TIME_ZONE }));
  const day = istTime.getDay(); // 0 = Sunday, 6 = Saturday
  const minutes = istTime.getHours() * 60 + istTime.getMinutes();

  const isWeekday = day >= 1 && day <= 5;
  const isDuringTradingHours = minutes >= MARKET_OPEN_MINUTES && minutes < MARKET_CLOSE_MINUTES;
  const isOpen = isWeekday && isDuringTradingHours;

  return {
    isOpen,
    region: 'NSE / BSE',
    session: isOpen ? 'REGULAR' : 'CLOSED',
    closesAt: '15:30 IST',
    serverTime: `${istTime.toLocaleTimeString('en-US', { timeZone: IST_TIME_ZONE })} IST`,
  };
};
