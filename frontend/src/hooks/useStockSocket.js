import { useEffect, useMemo, useState, useRef } from 'react';
import { io } from 'socket.io-client';

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || 'http://localhost:3000';

export function useStockSocket(symbol) {
  const [status, setStatus] = useState('Disconnected');
  const [quote, setQuote] = useState(null);
  const socketRef = useRef(null);
  const normalizedSymbol = useMemo(() => symbol?.toUpperCase?.() || '', [symbol]);

  useEffect(() => {
    if (!normalizedSymbol) return undefined;

    const socket = io(SOCKET_URL, {
      transports: ['websocket'],
      autoConnect: false,
    });

    socketRef.current = socket;

    const connect = () => setStatus('Connected');
    const disconnect = () => setStatus('Disconnected');
    const errorHandler = () => setStatus('Disconnected');

    socket.on('connect', connect);
    socket.on('disconnect', disconnect);
    socket.on('connect_error', errorHandler);
    socket.on('stockUpdate', (data) => {
      if (data?.symbol === normalizedSymbol) {
        setQuote(data);
      }
    });

    socket.connect();
    socket.emit('subscribe', { symbol: normalizedSymbol });

    return () => {
      socket.emit('unsubscribe', { symbol: normalizedSymbol });
      socket.disconnect();
      setStatus('Disconnected');
      setQuote(null);
    };
  }, [normalizedSymbol]);

  return { status, quote };
}
