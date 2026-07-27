const API_KEY = "7vZ6iO8XufR7x5VcZAtXzMXfYx3dMYtM";



// async function getStock(company){

// try {

// const searchRes = await fetch(
// `https://financialmodelingprep.com/stable/search-symbol?query=${company}&apikey=${API_KEY}`
// );

// const searchData = await searchRes.json();


// const stock = searchData.find(
// s => s.exchange === "NSE"
// );


// if(!stock){
//  console.log("NSE stock not found");
//  return;
// }


// console.log("\nCompany");
// console.log(stock.name);
// console.log(stock.symbol);
// console.log(stock.exchange);



// const quoteRes = await fetch(
// `https://financialmodelingprep.com/stable/quote?symbol=${stock.symbol}&apikey=${API_KEY}`
// );


// const quoteData = await quoteRes.text();


// console.log("\nPrice Data");
// console.log("----------------");
// console.log("Price:", quoteData[0].price);
// console.log("High:", quoteData[0].dayHigh);
// console.log("Low:", quoteData[0].dayLow);


// }catch(err){
//  console.log(err);
// }

// }


// getStock("SBIN");
import YahooFinance from "yahoo-finance2";


const yahooFinance = new YahooFinance();


async function getStock(symbol) {

    try {

        const quote = await yahooFinance.quote(symbol);


        console.log("\nCompany Information");
        console.log("----------------------------");
        console.log("Name:", quote.shortName || quote.longName);
        console.log("Symbol:", quote.symbol);
        console.log("Exchange:", quote.fullExchangeName);


        console.log("\nRealtime Market Data");
        console.log("----------------------------");
        console.log("Current Price:", quote.regularMarketPrice);
        console.log("Open:", quote.regularMarketOpen);
        console.log("Day High:", quote.regularMarketDayHigh);
        console.log("Day Low:", quote.regularMarketDayLow);
        console.log("Previous Close:", quote.regularMarketPreviousClose);
        console.log("Volume:", quote.regularMarketVolume);


        console.log("\n52 Week Data");
        console.log("----------------------------");
        console.log("52 Week High:", quote.fiftyTwoWeekHigh);
        console.log("52 Week Low:", quote.fiftyTwoWeekLow);


        console.log("\nCompany Statistics");
        console.log("----------------------------");
        console.log("Market Cap:", quote.marketCap);
        console.log("P/E Ratio:", quote.trailingPE);


    } catch(error) {

        console.log("Error:", error.message);

    }
}


// Indian NSE stock
getStock("NIFTYIT.NS");