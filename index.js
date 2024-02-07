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

var valorentrada = 0;
var operando = false;
var infos;
var operador;
var response2;
var response3;
var json;
var finaliza = false;
var filters = {};
var retorno = {};
var apiKey = '';
var secret = '';

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
      infos = JSON.parse(data);
      console.log(infos);

      if (infos.APIKEY != undefined) {
        apiKey = infos.APIKEY;
      }
      if (infos.APISECRET != undefined) {
        secret = infos.APISECRET;
      }

      const binance2 = new Binance().options({        
        APIKEY: apiKey,
        APISECRET: secret,
        'family': 4,
        recvWindow: 60000,
        urls:{base:"https://testnet.binance.vision/api/"}
      });

      if (infos.saldo != undefined) {
        binance2.balance((error, balances) => {
          if ( error ) {return console.error(error.body);}
          //console.info("balances()", balances);
          ws.send(JSON.stringify({saldo:true,balance:balances}));
          //console.info("ETH balance: ", balances.ETH.available);
        });
        return false;
      }

      if (infos.quantity == undefined) {
        if (!operando) {
          operando = true;
          operador = infos;
          opera(1);
        }
        else {
          ws.send(JSON.stringify({error:'Já está em operação, aguarde finalizar.'}));
        }
        
      }
      else {
        json = infos;
      }
      valorentrada = json.quantity;      
      
      binance2.exchangeInfo(function(error, data) {
        if ( error ) {
          console.error(error.body);
          ws.send('{"error":"Falha ao iniciar a operação."}');
          return false;
        }
        for ( let obj of data.symbols ) {
          //if (obj.symbol == 'LINAUSDT') { console.log(obj); }
          let filtro = {status: obj.status};
          for ( let filter of obj.filters ) {
            if ( filter.filterType == "MIN_NOTIONAL" ) {
              filtro.minNotional = filter.minNotional;
            } else if ( filter.filterType == "PRICE_FILTER" ) {
              filtro.minPrice = filter.minPrice;
              filtro.maxPrice = filter.maxPrice;
              filtro.tickSize = filter.tickSize;
            } else if ( filter.filterType == "LOT_SIZE" ) {
              filtro.stepSize = filter.stepSize;
              filtro.minQty = filter.minQty;
              filtro.maxQty = filter.maxQty;
            }
          }
          //filters.baseAssetPrecision = obj.baseAssetPrecision;
          //filters.quoteAssetPrecision = obj.quoteAssetPrecision;
          filtro.orderTypes = obj.orderTypes;
          filtro.icebergAllowed = obj.icebergAllowed;
          filters[obj.symbol] = filtro;
        }
        //console.log(filters['LINAUSDT']);
      

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

        var counter = 0;

        // every pingback from the websocket(s)
        ctrl.storage.streamTick = (stream, streamID) => {
          ctrl.storage.streams[streamID] = stream;

          if (counter == 0) {
            binance2.balance((error, balances) => {
              if ( error ) return console.error(error.body);
              //console.info("balances()", balances);
              ws.send(JSON.stringify({saldo:true,balance:balances}));
              //console.info("ETH balance: ", balances.ETH.available);
            });
          }
          counter++;
          if (counter > 10) {
            counter = 0;
          }

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

            if (retorno.final != undefined) {
              retorno.valor = valorentrada;
              ws.send(JSON.stringify(retorno));
              retorno = {};
            }
            /*ctrl.storage.candidates.every(function (item){
              var rate = ((item.rate - 1)* 100);
              var fees2 = rate * 0.1; //other
              var fRate2 = rate - fees2;
              if (fRate2 > parseFloat(json.perc) && !operando && !finaliza) {
                operando = true;   
                finaliza = true; // Vamos parar com a primeira operação           
                ws.send(JSON.stringify(item));
                operador = item;
                //console.log(item);
                //opera(1);
                return false;
              }
              else {
                return true;
              }            
            }); */
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
      });
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
    APIKEY: apiKey,
    APISECRET: secret,
    'family': 4,
    recvWindow: 60000,
    urls:{base:"https://testnet.binance.vision/api/"}
  });
  /*APIKEY: 'MbB6qWbP2yk7Pwd1pY0zvBhQBSUcBG5qn0ZBRlHnhRjBnes4dxQSCw4zL4yL7nNa',
  APISECRET: 'FSDsSEZQHIWLlP3duXF3e4X52LchiMrl5d2XkgUibPzhEN79dQfNT7odvgMpq5ca',*/

  if (fase == 1) {

    console.log('----Passo 1: '+operador.a_symbol+': '+operador.a_step_type);
    let filter = filters[operador.a_symbol];

    if (operador.a_step_type == 'BUY') {

      valorentrada = Math.floor(valorentrada / filter.tickSize) * filter.tickSize;
      valorentrada = valorentrada.toFixed(8);      

      binance.marketBuy(operador.a_symbol, false,{type:'MARKET', quoteOrderQty: parseFloat(valorentrada)} ,(error, response) => {
        if (error != null) {
          console.info("Error", error.body);
          retorno.final = true;
          retorno.error = error.body;
          operando = false;
        }
        else {
          retorno.passo1 = {
            moeda: operador.a_symbol,
            operacao: 'BUY',
            entrada: response.cummulativeQuoteQty,
            saida: response.executedQty
          };
          console.info('cummulativeQuoteQty: '+response.cummulativeQuoteQty+' / executedQty: '+response.executedQty);
          valorentrada = response.cummulativeQuoteQty;
          response2 = response;
          opera(2)
        }
      });
    }
    else {

      valorentrada = Math.floor(valorentrada / filter.stepSize) * filter.stepSize;
      valorentrada = valorentrada.toFixed(8);

      binance.marketSell(operador.a_symbol,  parseFloat(valorentrada) ,(error, response) => {
        if (error != null) {
          console.info("Error", error.body);
          retorno.final = true;
          retorno.error = error.body;
          operando = false;
        }
        else {
          retorno.passo1 = {
            moeda: operador.a_symbol,
            operacao: 'SELL',
            entrada: response.executedQty,
            saida: response.cummulativeQuoteQty
          };
          valorentrada = response.executedQty;
          console.info('cummulativeQuoteQty: '+response.cummulativeQuoteQty+' / executedQty: '+response.executedQty)
          response2 = response;
          opera(2)
        }
      });
    }
  }
  else if (fase == 2) {

    console.log('----Passo 2');
    let filter = filters[operador.b_symbol];

    let quantity2 = response2.cummulativeQuoteQty - response2.fills[0].commission;       
    if (operador.a_step_type == 'BUY') {
      quantity2 = response2.executedQty - response2.fills[0].commission;
    }
    console.log(operador.b_symbol);
    //console.log(filter);
    if (operador.b_step_type == 'BUY') {  

      quantity2 = Math.floor(quantity2 / filter.tickSize) * filter.tickSize;
      quantity2 = quantity2.toFixed(8);
      console.log(quantity2);
      //quantity2 = parseFloat(quantity2).toFixed(8);
      if (quantity2 < filter.tickSize) {
        console.log('Quantidade mínima não atingida.');
        retorno.final = true;
        retorno.error = error.body;
        operando = false;
        return false;
      }
      binance.marketBuy(operador.b_symbol, false,{type:'MARKET', quoteOrderQty: parseFloat(quantity2)} ,(error, response) => {
        if (error != null) {
          console.info("Error", error.body);
          retorno.final = true;
          retorno.error = error.body;
          operando = false;
        }
        else {
          retorno.passo2 = {
            moeda: operador.b_symbol,
            operacao: 'BUY',
            entrada: response.cummulativeQuoteQty,
            saida: response.executedQty
          };
          console.info('cummulativeQuoteQty: '+response.cummulativeQuoteQty+' / executedQty: '+response.executedQty)
          response3 = response;
          opera(3)
        }
      });
    }
    else {

      quantity2 = Math.floor(quantity2 / filter.stepSize) * filter.stepSize;
      quantity2 = quantity2.toFixed(8);
      console.log(quantity2);
      ///quantity2 = parseFloat(quantity2).toFixed(8);
      if (quantity2 < filter.minQty) {
        console.log('Quantidade mínima não atingida.');
        retorno.final = true;
        retorno.error = error.body;
        operando = false;
        return false;
      }
      binance.marketSell(operador.b_symbol,  parseFloat(quantity2) ,(error, response) => {
        if (error != null) {
          console.info("Error", error.body);
          retorno.final = true;
          retorno.error = error.body;
          operando = false;
        }
        else {
          retorno.passo2 = {
            moeda: operador.b_symbol,
            operacao: 'SELL',
            entrada: response.executedQty,
            saida: response.cummulativeQuoteQty
          };
          console.info('cummulativeQuoteQty: '+response.cummulativeQuoteQty+' / executedQty: '+response.executedQty)
          response3 = response;
          opera(3)
        }
      });
    }
  }
  else if (fase == 3) {

    console.log('----Passo 3');
    let filter = filters[operador.c_symbol];

    let quantity3 = response3.cummulativeQuoteQty - response3.fills[0].commission;
    if (operador.b_step_type == 'BUY') {
      quantity3 = response3.executedQty - response3.fills[0].commission;
    }
    console.log(quantity3);
    console.log(operador.c_symbol);
    //console.log(filter);
    if (operador.c_step_type == 'BUY') {  

      quantity3 = Math.floor(quantity3 / filter.tickSize) * filter.tickSize;
      quantity3 = quantity3.toFixed(8);
      console.log(quantity3);
      //quantity3 = parseFloat(quantity3).toFixed(8);
      if (quantity3 < filter.tickSize) {
        console.log('Quantidade mínima não atingida.');
        retorno.final = true;
        retorno.error = error.body;
        return false;
      }
      binance.marketBuy(operador.c_symbol, false,{type:'MARKET', quoteOrderQty: parseFloat(quantity3)} ,(error, response) => {
        if (error != null) {
          console.info("Error", error.body);
          retorno.final = true;
          retorno.error = error.body;
          operando = false;
        }
        else {
          retorno.passo3 = {
            moeda: operador.c_symbol,
            operacao: 'BUY',
            entrada: response.cummulativeQuoteQty,
            saida: response.executedQty
          };
          console.info('cummulativeQuoteQty: '+response.cummulativeQuoteQty+' / executedQty: '+response.executedQty)
          console.info('---------------------------');
          retorno.valorfinal = response.executedQty;
          retorno.final = true;
          operando = false;
        }
      });
    }
    else {

      quantity3 = Math.floor(quantity3 / filter.stepSize) * filter.stepSize;
      quantity3 = quantity3.toFixed(8);
      console.log(quantity3);
      //quantity3 = parseFloat(quantity3).toFixed(8);
      if (quantity3 < filter.minQty) {
        console.log('Quantidade mínima não atingida.');
        retorno.final = true;
        retorno.error = error.body;
        operando = false;
        return false;
      }

      binance.marketSell(operador.c_symbol, parseFloat(quantity3) ,(error, response) => {
        if (error != null) {
          
          console.info("Error", error );
          console.info("Error", error.body);
          retorno.final = true;
          retorno.error = error.body;
          operando = false;
        }
        else {
          retorno.passo3 = {
            moeda: operador.c_symbol,
            operacao: 'SELL',
            entrada: response.executedQty,
            saida: response.cummulativeQuoteQty
          };
          console.info('cummulativeQuoteQty: '+response.cummulativeQuoteQty+' / executedQty: '+response.executedQty)
          console.info('---------------------------');
          retorno.valorfinal = response.cummulativeQuoteQty;
          retorno.final = true;
          operando = false;
        }
      });
    }
  }
  
}