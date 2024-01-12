const WebSocket = require('ws');
var TradingCore = require('./lib/TradingCore');
var DBHelpers = require('./lib/DBHelpers').DBHelpers;
var PairRanker = require('./lib/PairRanker').PairRanker;
const Binance = require('node-binance-api');

const wss = new WebSocket.Server({ port: 8080 });

// load logger library
const logger = require('./lib/LoggerCore');

var env = require('node-env-file');
try {
  env(__dirname + '/.keys');
} catch (e) {
  console.warn('No .keys was provided, running with defaults.');
}
env(__dirname + '/conf.ini');

logger.info('\n\n\n----- Bot Starting : -----\n\n\n');

var exchangeAPI = {};

logger.info('--- Loading Exchange API');

var operando = false;
var operador;
var response2;
var response3;
var json;
var finaliza = false;

// make exchange module dynamic later
if (process.env.activeExchange == 'binance'){
  logger.info('--- \tActive Exchange:' + process.env.activeExchange);
  // activePairs = process.env.binancePairs;

  const api = require('binance');
  const beautifyResponse = false;
  exchangeAPI = new api.BinanceRest({
    timeout: parseInt(process.env.restTimeout), // Optional, defaults to 15000, is the request time out in milliseconds
    recvWindow: parseInt(process.env.restRecvWindow), // Optional, defaults to 5000, increase if you're getting timestamp errors
    disableBeautification: beautifyResponse
  });
  exchangeAPI.WS = new api.BinanceWS(beautifyResponse);
}

wss.on('connection', function connection(ws) {
  ws.on('message', function message(data) {
    try {
      json = JSON.parse(data);
      console.log(json);

      // if (json.fim != undefined) {
      //   finaliza = true;
      //   return false;
      // }

      finaliza = false;
      this.dbHelpers = new DBHelpers();
      this.pairRanker = new PairRanker();

      var ctrl = {
        options: {
          UI: {
            title: 'Top Potential Arbitrage Triplets, via: ' + process.env.binanceColumns
          },
          arbitrage: {
            paths: json.binanceColumns.split(','),
            start: json.binanceStartingPoint
          },
          storage: {
            logHistory: false
          },
          trading: {
            paperOnly: true,
            // only candidates with over x% gain potential are queued for trading
            minQueuePercentageThreshold: 3,
            // how many times we need to see the same opportunity before deciding to act on it
            minHitsThreshold: 5
          }
        },
        storage: {
          trading: {
          // queued triplets
            queue: [],
            // actively trading triplets
            active: []
          },
          candidates: [],
          streams: [],
          pairRanks: []
        },
        logger: logger,
        exchange: exchangeAPI
      };

      // every pingback from the websocket(s)
      ctrl.storage.streamTick = (stream, streamID) => {
        ctrl.storage.streams[streamID] = stream;

        if (streamID == 'allMarketTickers') {
          // Run logic to check for arbitrage opportunities
          ctrl.storage.candidates = ctrl.currencyCore.getDynamicCandidatesFromStream(stream, ctrl.options.arbitrage);

          // Run logic to check for each pairs ranking
          var pairToTrade = this.pairRanker.getPairRanking(ctrl.storage.candidates, ctrl.storage.pairRanks, ctrl, ctrl.logger);
          if (pairToTrade != 'none') {
            // console.log("<----GO TRADE---->");
          }

          // queue potential trades
          if (this.tradingCore)
            this.tradingCore.updateCandidateQueue(stream, ctrl.storage.candidates, ctrl.storage.trading.queue);

          ctrl.storage.candidates.every(function (item){
            var rate = ((item.rate - 1)* 100);
            var fees2 = rate * 0.1; //other
            var fRate2 = rate - fees2;
            if (fRate2 > parseFloat(json.perc) && !operando && !finaliza) {
              operando = true;   
              finaliza = true; // Vamos parar com a primeira operação           
              ws.send(JSON.stringify(item));
              operador = item;
              opera(1);
              return false;
            }
            else {
              return true;
            }            
          }); 
          //ws.send(JSON.stringify(ctrl.storage.candidates));
          // update UI with latest values per currency
          //ctrl.UI.updateArbitageOpportunities(ctrl.storage.candidates);

          if (ctrl.options.storage.logHistory) {
            // Log arbitrage data to DB, if enabled
            this.dbHelpers.saveArbRows(ctrl.storage.candidates, ctrl.storage.db, ctrl.logger);
            this.dbHelpers.saveRawTick(stream.arr, ctrl.storage.db, ctrl.logger);
          }

        }
      }

      // loading the CurrencyCore starts the streams
      ctrl.logger.info('--- Starting Currency Streams');
      ctrl.currencyCore = require('./lib/CurrencyCore')(ctrl);

      this.tradingCore = TradingCore(ctrl.options.trading, ctrl.currencyCore);
      // use this for callbacks for ongoing trade workflows
      // this.tradingCore.on('queueUpdated', (queue, timeStarted)=>{  });
      // this.tradingCore.on('newTradeQueued', (candidate, timeStarted)=>{  });
    } catch (error) {
      console.error(error);
      ws.send('{"error":"'+error+'"}');
      // Expected output: ReferenceError: nonExistentFunction is not defined
      // (Note: the exact output may be browser-dependent)
    }
  });

});

var opera = function(fase) {  

  const binance = new Binance().options({
    APIKEY: json.APIKEY, //'MbB6qWbP2yk7Pwd1pY0zvBhQBSUcBG5qn0ZBRlHnhRjBnes4dxQSCw4zL4yL7nNa',
    APISECRET: json.APISECRET, //'FSDsSEZQHIWLlP3duXF3e4X52LchiMrl5d2XkgUibPzhEN79dQfNT7odvgMpq5ca',
    'family': 4,
    urls:{base:"https://testnet.binance.vision/api/"}
  });

  if (fase == 1) {
    if (operador.a_step_type == 'BUY') {
      binance.marketBuy(operador.a_symbol, false,{type:'MARKET', quoteOrderQty: json.quantity} ,(error, response) => {
        if (error != null) {
          console.info("Error", error.body);
        }
        else {
          console.info('cummulativeQuoteQty: '+response.cummulativeQuoteQty+' / executedQty: '+response.executedQty)
          response2 = response;
          opera(2)
        }
      });
    }
    else {
      binance.marketSell(operador.a_symbol, false,{type:'MARKET', quoteOrderQty: json.quantity} ,(error, response) => {
        if (error != null) {
          console.info("Error", error.body);
        }
        else {
          console.info('cummulativeQuoteQty: '+response.cummulativeQuoteQty+' / executedQty: '+response.executedQty)
          response2 = response;
          opera(2)
        }
      });
    }
  }
  else if (fase == 2) {

    let quantity2 = response2.cummulativeQuoteQty - response2.fills[0].commission;
    if (operador.a_step_type == 'BUY') {
      quantity2 = response2.executedQty - response2.fills[0].commission;
    }
    if (operador.b_step_type == 'BUY') {  
      binance.marketBuy(operador.b_symbol, false,{type:'MARKET', quoteOrderQty: quantity2} ,(error, response) => {
        if (error != null) {
          console.info("Error", error.body);
        }
        else {
          console.info('cummulativeQuoteQty: '+response.cummulativeQuoteQty+' / executedQty: '+response.executedQty)
          response3 = response;
          opera(3)
        }
      });
    }
    else {
      binance.marketSell(operador.b_symbol, false,{type:'MARKET', quoteOrderQty: json.quantity} ,(error, response) => {
        if (error != null) {
          console.info("Error", error.body);
        }
        else {
          console.info('cummulativeQuoteQty: '+response.cummulativeQuoteQty+' / executedQty: '+response.executedQty)
          response3 = response;
          opera(3)
        }
      });
    }
  }
  else if (fase == 3) {

    let quantity3 = response3.cummulativeQuoteQty - response3.fills[0].commission;
    if (operador.b_step_type == 'BUY') {
      quantity2 = response2.executedQty - response2.fills[0].commission;
    }
    if (operador.c_step_type == 'BUY') {  
      binance.marketBuy(operador.c_symbol, false,{type:'MARKET', quoteOrderQty: quantity3} ,(error, response) => {
        console.info('cummulativeQuoteQty: '+response.cummulativeQuoteQty+' / executedQty: '+response.executedQty)
        console.info('---------------------------');
        operando = false;
      });
    }
    else {
      binance.marketSell(operador.c_symbol, false,{type:'MARKET', quoteOrderQty: json.quantity} ,(error, response) => {
        console.info('cummulativeQuoteQty: '+response.cummulativeQuoteQty+' / executedQty: '+response.executedQty)
        console.info('---------------------------');
        operando = false;
      });
    }
  }
  
}