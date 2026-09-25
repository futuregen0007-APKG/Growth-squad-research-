/** The 5 most recent COMPLETED Indian fiscal years (FY ends 31 March) -- the same window getCompanyReport uses. */
export const getFiscalWindow = (now = new Date()) => {
  const latest = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return { fromYear: latest - 4, toYear: latest, expectedYears: 5 };
};

export default getFiscalWindow;
