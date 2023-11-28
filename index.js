const WebSocket = require('ws');
var TradingCore = require('./lib/TradingCore');
var DBHelpers = require('./lib/DBHelpers').DBHelpers;
var PairRanker = require('./lib/PairRanker').PairRanker;

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
      var json = JSON.parse(data);
      console.log(json);
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

          ws.send(JSON.stringify(ctrl.storage.candidates));
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