const response = await fetch("https://financialmodelingprep.com");

console.log(response.status);

const text = await response.text();

console.log(text.slice(0,200));