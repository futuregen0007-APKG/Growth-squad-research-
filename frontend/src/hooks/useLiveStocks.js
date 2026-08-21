import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import API_BASE from '@/config/api';

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || API_BASE;

export function useLiveStocks(symbols) {
  const [quotes, setQuotes] = useState({});
  const symbolKey = symbols
    .map((symbol) => String(symbol || '').toUpperCase())
    .filter(Boolean);
  const normalizedSymbolKey = symbolKey.join(',');

  useEffect(() => {
    const normalizedSymbols = normalizedSymbolKey.split(',').filter(Boolean);
    if (!normalizedSymbols.length) return undefined;

    const socket = io(SOCKET_URL, { transports: ['websocket'] });
    const handleUpdate = (quote) => {
      if (!quote?.symbol) return;
      setQuotes((current) => ({ ...current, [quote.symbol]: quote }));
    };

    socket.on('stockUpdate', handleUpdate);
    socket.on('connect', () => {
      normalizedSymbols.forEach((symbol) => socket.emit('subscribe', { symbol }));
    });

    return () => {
      normalizedSymbols.forEach((symbol) => socket.emit('unsubscribe', { symbol }));
      socket.disconnect();
    };
  }, [normalizedSymbolKey]);

  return quotes;
}