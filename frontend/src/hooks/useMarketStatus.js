import { useState, useEffect } from 'react';

export function useMarketStatus() {
  const [status, setStatus] = useState({
    isOpen: false,
    session: 'CLOSED',
    nextOpen: null,
    closesAt: null,
  });

  useEffect(() => {
    const checkMarketStatus = () => {
      const now = new Date();
      const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      
      const day = istTime.getDay();
      const hours = istTime.getHours();
      const minutes = istTime.getMinutes();
      const currentTime = hours * 60 + minutes;
      
      // Market hours: 9:15 AM (555) to 3:30 PM (930)
      const marketOpen = 9 * 60 + 15; // 9:15 AM
      const marketClose = 15 * 60 + 30; // 3:30 PM
      
      const isOpen = day >= 1 && day <= 5 && currentTime >= marketOpen && currentTime <= marketClose;
      
      let session = 'CLOSED';
      if (isOpen) {
        session = 'REGULAR';
      } else if (day >= 1 && day <= 5) {
        if (currentTime < marketOpen) {
          session = 'PRE-MARKET';
        } else if (currentTime > marketClose) {
          session = 'AFTER-HOURS';
        }
      } else {
        session = 'WEEKEND';
      }

      // Calculate next open time
      let nextOpen = null;
      if (!isOpen) {
        const nextOpenDate = new Date(istTime);
        if (day === 0) {
          // Sunday, next open is Monday 9:15 AM
          nextOpenDate.setDate(nextOpenDate.getDate() + 1);
        } else if (day === 6) {
          // Saturday, next open is Monday 9:15 AM
          nextOpenDate.setDate(nextOpenDate.getDate() + 2);
        } else if (currentTime > marketClose) {
          // Weekday after close, next open is tomorrow 9:15 AM
          nextOpenDate.setDate(nextOpenDate.getDate() + 1);
        } else {
          // Weekday before open, next open is today 9:15 AM
        }
        nextOpenDate.setHours(9, 15, 0, 0);
        nextOpen = nextOpenDate;
      }

      setStatus({
        isOpen,
        session,
        nextOpen,
        closesAt: isOpen ? new Date(istTime).setHours(15, 30, 0, 0) : null,
      });
    };

    checkMarketStatus();
    const interval = setInterval(checkMarketStatus, 60000); // Check every minute
    
    return () => clearInterval(interval);
  }, []);

  return status;
}
