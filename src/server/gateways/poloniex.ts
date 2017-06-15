import autobahn = require('autobahn');
import crypto = require("crypto");
import request = require("request");
import url = require("url");
import Config = require("../config");
import NullGateway = require("./nullgw");
import Models = require("../../share/models");
import Utils = require("../utils");
import util = require("util");
import Interfaces = require("../interfaces");
import * as Promises from '../promises';

interface PoloniexMessageIncomingMessage {
    channel: string;
    success: boolean;
    data: any;
    event?: string;
    errorcode: number;
    order_id: string;
}

interface PoloniexDepthMessage {
    asks: [number, number][];
    bids: [number, number][];
    timestamp: string;
}

interface OrderAck {
    result: boolean;
    order_id: number;
}

interface SignedMessage {
    command?: string;
    nonce?: number;
}

interface Order extends SignedMessage {
    symbol: string;
    type: string;
    price: string;
    amount: string;
}

interface Cancel extends SignedMessage {
    order_id: string;
    symbol: string;
}

interface PoloniexTradeRecord {
    averagePrice: string;
    completedTradeAmount: string;
    createdDate: string;
    id: string;
    orderId: string;
    sigTradeAmount: string;
    sigTradePrice: string;
    status: number;
    symbol: string;
    tradeAmount: string;
    tradePrice: string;
    tradeType: string;
    tradeUnitPrice: string;
    unTrade: string;
}

class PoloniexWebsocket {

	send = <T>(channel : string, parameters: any, cb?: () => void) => {
        var subsReq : any = {event: 'addChannel', channel: channel};

        if (parameters !== null)
            subsReq.parameters = parameters;

        this._ws.send(JSON.stringify(subsReq), (e: Error) => {
            if (!e && cb) cb();
        });
    }

    setHandler = <T>(channel : string, handler: (newMsg : Models.Timestamped<T>) => void) => {
        this._handlers[channel] = handler;
    }

    private onMessage = (raw : string) => {
        var t = new Date();
        try {
            var msg : PoloniexMessageIncomingMessage = JSON.parse(raw)[0];
            if (typeof msg === "undefined") msg = JSON.parse(raw);
            if (typeof msg === "undefined") throw new Error("Unkown message from Poloniex socket: " + raw);

            if (typeof msg.event !== "undefined" && msg.event == "pong") {
                this._stillAlive = true;
                return;
            }

            let channel: string = typeof msg.channel !== 'undefined' ? msg.channel : msg.data.channel;
            let success: boolean = typeof msg.success !== 'undefined' ? msg.success : (typeof msg.data !== 'undefined' && typeof msg.data.result !== 'undefined' ? msg.data.result : true);
            let errorcode: number = typeof msg.errorcode !== 'undefined' ? msg.errorcode : msg.data.error_code;

            if (!success && (typeof errorcode === "undefined" || (
              errorcode != 20100 /* 20100=request time out */
              && errorcode != 10002 /* 10002=System error */
              && errorcode != 10050 /* 10050=Can't cancel more than once */
              && errorcode != 10009 /* 10009=Order does not exist */
              && errorcode != 10010 /* 10010=Insufficient funds */
              && errorcode != 10016 /* 10016=Insufficient coins balance */
              // errorcode != 10001 /* 10001=Request frequency too high */
            ))) console.warn(new Date().toISOString().slice(11, -1), 'poloniex', 'Unsuccessful message received:', raw);
            else if (success && (channel == 'addChannel' || channel == 'login'))
              return console.info(new Date().toISOString().slice(11, -1), 'poloniex', 'Successfully connected to', channel + (typeof msg.data.channel !== 'undefined' ? ': '+msg.data.channel : ''));
            if (typeof errorcode !== "undefined" && (
              errorcode == 20100
              || errorcode == 10002
              || errorcode == 10050
              || errorcode == 10009
              // || errorcode == '10001'
            ))  return;

            var handler = this._handlers[channel];

            if (typeof handler === "undefined") {
                console.warn(new Date().toISOString().slice(11, -1), 'poloniex', 'Got message on unknown topic', msg);
                return;
            }

            handler(new Models.Timestamped(msg.data, t));
        }
        catch (e) {
            console.error(new Date().toISOString().slice(11, -1), 'poloniex', e, 'Error parsing msg', raw);
            throw e;
        }
    };

    private connectWS = (config: Config.ConfigProvider) => {
        this._ws = new autobahn.Connection({ url: config.GetString("PoloniexWebsocketUrl"), realm: "realm1" });
        this._ws.onclose = () => this.ConnectChanged.trigger(Models.ConnectivityStatus.Disconnected);
        this._ws.onopen = (session: any) => {
          session.subscribe(this.symbolProvider.symbol, (args, kwargs) => {
            console.log(args);
            // this.onMessage(args);
          });
          this.ConnectChanged.trigger(Models.ConnectivityStatus.Connected);
          console.info(new Date().toISOString().slice(11, -1), 'poloniex', 'Successfully connected to Poloniex', this.symbolProvider.symbol);
        };
        this._ws.open();
    };

    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();
    private _stillAlive: boolean = true;
    private _handlers : { [channel : string] : (newMsg : Models.Timestamped<any>) => void} = {};
    private _ws : autobahn.Connection;
    constructor(config: Config.ConfigProvider, private symbolProvider: PoloniexSymbolProvider) {
        this.connectWS(config);
        setInterval(() => {
          if (!this._stillAlive) {
            console.warn(new Date().toISOString().slice(11, -1), 'poloniex', 'Heartbeat lost, reconnecting...');
            this._stillAlive = true;
            this.connectWS(config);
          } else this._stillAlive = false;
        }, 21000);
    }
}

class PoloniexMarketDataGateway implements Interfaces.IMarketDataGateway {
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    MarketTrade = new Utils.Evt<Models.GatewayMarketTrade>();
    private onTrade = (trades : Models.Timestamped<[string,string,string,string,string][]>) => {
        // trades.data.forEach(trade => { // [tid, price, amount, time, type]
            // var px = parseFloat(trade[1]);
            // var amt = parseFloat(trade[2]);
            // var side = trade[4] === "ask" ? Models.Side.Ask : Models.Side.Bid;
            // var mt = new Models.GatewayMarketTrade(px, amt, trades.time, trades.data.length > 0, side);
            // this.MarketTrade.trigger(mt);
        // });
    };

    MarketData = new Utils.Evt<Models.Market>();

    private static GetLevel = (n: [any, any]) : Models.MarketSide =>
        new Models.MarketSide(parseFloat(n[0]), parseFloat(n[1]));

    private onDepth = (depth : Models.Timestamped<PoloniexDepthMessage>) => {
        // var msg = depth.data;

        // var bids = msg.bids.slice(0,13).map(PoloniexMarketDataGateway.GetLevel);
        // var asks = msg.asks.reverse().slice(0,13).map(PoloniexMarketDataGateway.GetLevel);
        // var mkt = new Models.Market(bids, asks, depth.time);

        // this.MarketData.trigger(mkt);
    };

    constructor(socket: PoloniexWebsocket, symbolProvider: PoloniexSymbolProvider) {
        // var depthChannel = "ok_sub_spot" + symbolProvider.symbol + "_depth_20";
        // var tradesChannel = "ok_sub_spot" + symbolProvider.symbol + "_trades";
        // socket.setHandler(depthChannel, this.onDepth);
        // socket.setHandler(tradesChannel, this.onTrade);

        socket.ConnectChanged.on(cs => {
            this.ConnectChanged.trigger(cs);
        });
    }
}

// class PoloniexOrderEntryGateway implements Interfaces.IOrderEntryGateway {
    // OrderUpdate = new Utils.Evt<Models.OrderStatusUpdate>();
    // ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    // private chars: string = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    // generateClientOrderId = (): string => {
      // let id: string = '';
      // for(let i=8;i--;) id += this.chars.charAt(Math.floor(Math.random() * this.chars.length));
      // return id;
    // };

    // supportsCancelAllOpenOrders = () : boolean => { return false; };
    // cancelAllOpenOrders = () : Promise<number> => {
        // var d = Promises.defer<number>();
        // this._http.post("order_info.do", <Cancel>{order_id: '-1', symbol: this._symbolProvider.symbol }).then(msg => {
          // if (typeof (<any>msg.data).orders == "undefined"
            // || typeof (<any>msg.data).orders[0] == "undefined"
            // || typeof (<any>msg.data).orders[0].order_id == "undefined") { d.resolve(0); return; }
          // (<any>msg.data).orders.map((o) => {
              // this._http.post("cancel_order.do", <Cancel>{order_id: o.order_id.toString(), symbol: this._symbolProvider.symbol }).then(msg => {
                  // if (typeof (<any>msg.data).result == "undefined") return;
                  // if ((<any>msg.data).result) {
                      // this.OrderUpdate.trigger(<Models.OrderStatusUpdate>{
                        // exchangeId: (<any>msg.data).order_id.toString(),
                        // leavesQuantity: 0,
                        // time: msg.time,
                        // orderStatus: Models.OrderStatus.Cancelled
                      // });
                  // }
              // });
          // });
          // d.resolve((<any>msg.data).orders.length);
        // });
        // return d.promise;
    // };

    // public cancelsByClientOrderId = false;

    // private static GetOrderType(side: Models.Side, type: Models.OrderType) : string {
        // if (side === Models.Side.Bid) {
            // if (type === Models.OrderType.Limit) return "buy";
            // if (type === Models.OrderType.Market) return "buy_market";
        // }
        // if (side === Models.Side.Ask) {
            // if (type === Models.OrderType.Limit) return "sell";
            // if (type === Models.OrderType.Market) return "sell_market";
        // }
        // throw new Error("unable to convert " + Models.Side[side] + " and " + Models.OrderType[type]);
    // }

    //// let's really hope there's no race conditions on their end -- we're assuming here that orders sent first
    //// will be acked first, so we can match up orders and their acks
    // private _ordersWaitingForAckQueue = [];

    // sendOrder = (order : Models.OrderStatusReport) => {
        // var o : Order = {
            // symbol: this._symbolProvider.symbol,
            // type: PoloniexOrderEntryGateway.GetOrderType(order.side, order.type),
            // price: order.price.toString(),
            // amount: order.quantity.toString()};

        // this._ordersWaitingForAckQueue.push([order.orderId, order.quantity]);

        // this._socket.send<OrderAck>("ok_spot" + this._symbolProvider.symbol + "_trade", this._signer.signMessage(o), () => {
            // this.OrderUpdate.trigger(<Models.OrderStatusUpdate>{
                // orderId: order.orderId,
                // computationalLatency: new Date().valueOf() - order.time.valueOf()
            // });
        // });
    // };

    // private onOrderAck = (ts: Models.Timestamped<OrderAck>) => {
        // var order = this._ordersWaitingForAckQueue.shift();

        // var orderId = order[0];
        // if (typeof orderId === "undefined") {
            // console.error(new Date().toISOString().slice(11, -1), 'poloniex', 'got an order ack when there was no order queued!', util.format(ts.data));
            // return;
        // }

        // var osr : Models.OrderStatusUpdate = { orderId: orderId, time: ts.time };

        // if (typeof ts.data !== "undefined" && ts.data.result) {
            // osr.exchangeId = ts.data.order_id.toString();
            // osr.orderStatus = Models.OrderStatus.Working;
            // osr.leavesQuantity = order[1];
        // }
        // else {
            // osr.orderStatus = Models.OrderStatus.Rejected;
        // }

        // this.OrderUpdate.trigger(osr);
    // };

    // cancelOrder = (cancel : Models.OrderStatusReport) => {
        // var c : Cancel = {order_id: cancel.exchangeId, symbol: this._symbolProvider.symbol };
        // this._socket.send<OrderAck>("ok_spot" + this._symbolProvider.symbol + "_cancel_order", this._signer.signMessage(c), () => {
            // this.OrderUpdate.trigger(<Models.OrderStatusUpdate>{
                // orderId: cancel.orderId,
                // leavesQuantity: 0,
                // time: cancel.time,
                // orderStatus: Models.OrderStatus.Cancelled
            // });
        // });
    // };

    // private onCancel = (ts: Models.Timestamped<OrderAck>) => {
        // if (typeof ts.data.order_id == "undefined") return;
        // var osr : Models.OrderStatusUpdate = {
          // exchangeId: ts.data.order_id.toString(),
          // time: ts.time,
          // leavesQuantity: 0
        // };

        // if (ts.data.result) {
            // osr.orderStatus = Models.OrderStatus.Cancelled;
        // }
        // else {
            // osr.orderStatus = Models.OrderStatus.Rejected;
            // osr.cancelRejected = true;
        // }

        // this.OrderUpdate.trigger(osr);
    // };

    // replaceOrder = (replace : Models.OrderStatusReport) => {
        // this.cancelOrder(replace);
        // this.sendOrder(replace);
    // };

    // private static getStatus(status: number) : Models.OrderStatus {
        // // status: -1: cancelled, 0: pending, 1: partially filled, 2: fully filled, 4: cancel request in process
        // switch (status) {
            // case -1: return Models.OrderStatus.Cancelled;
            // case 0: return Models.OrderStatus.Working;
            // case 1: return Models.OrderStatus.Working;
            // case 2: return Models.OrderStatus.Complete;
            // case 4: return Models.OrderStatus.Working;
            // default: return Models.OrderStatus.Other;
        // }
    // }

    // private onTrade = (tsMsg : Models.Timestamped<PoloniexTradeRecord>) => {
        // var t = tsMsg.time;
        // var msg : PoloniexTradeRecord = tsMsg.data;
        // var avgPx = parseFloat(msg.averagePrice);
        // var lastQty = parseFloat(msg.sigTradeAmount);
        // var lastPx = parseFloat(msg.sigTradePrice);

        // var status : Models.OrderStatusUpdate = {
            // exchangeId: msg.orderId.toString(),
            // orderStatus: PoloniexOrderEntryGateway.getStatus(msg.status),
            // time: t,
            // side: msg.tradeType.indexOf('buy')>-1 ? Models.Side.Bid : Models.Side.Ask,
            // lastQuantity: lastQty > 0 ? lastQty : undefined,
            // lastPrice: lastPx > 0 ? lastPx : undefined,
            // averagePrice: avgPx > 0 ? avgPx : undefined,
            // pendingCancel: msg.status === 4,
            // partiallyFilled: msg.status === 1
        // };

        // this.OrderUpdate.trigger(status);
    // };

    // PositionUpdate = new Utils.Evt<Models.CurrencyPosition>();

    // private onPosition = (ts: Models.Timestamped<any>) => {
        // var free = (<any>ts.data).info.free;
        // var freezed = (<any>ts.data).info.freezed;

        // for (var currencyName in free) {
            // if (!free.hasOwnProperty(currencyName)) continue;
            // var amount = parseFloat(free[currencyName]);
            // var held = parseFloat(freezed[currencyName]);

            // var pos = new Models.CurrencyPosition(amount, held, Models.toCurrency(currencyName));
            // this.PositionUpdate.trigger(pos);
        // }
    // }

    // constructor(
            // private _http: PoloniexHttp,
            // private _signer: PoloniexMessageSigner,
            // private _symbolProvider: PoloniexSymbolProvider) {
        // _socket.setHandler("ok_sub_spot" + _symbolProvider.symbol + "_trades", this.onTrade);
        // _socket.setHandler("ok_spot" + _symbolProvider.symbol + "_trade", this.onOrderAck);
        // _socket.setHandler("ok_spot" + _symbolProvider.symbol + "_cancel_order", this.onCancel);
        // _socket.setHandler("ok_sub_spot" + _symbolProvider.symbol + "_userinfo", this.onPosition);

        // _socket.ConnectChanged.on(cs => {
            // this.ConnectChanged.trigger(cs);

            // if (cs === Models.ConnectivityStatus.Connected) {
                // _socket.send("ok_sub_spot" + _symbolProvider.symbol + "_trades", _signer.signMessage({}));
            // }
        // });
    // }
// }

class PoloniexMessageSigner {
  private _secretKey : string;
  private _api_key : string;

  public signMessage = (baseUrl: string, actionUrl: string, m : SignedMessage) : any => {
    var els : string[] = [];

    m.command = 'return'+actionUrl;
    m.nonce = Date.now();

    var keys = [];
    for (var key in m) {
      if (m.hasOwnProperty(key))
        keys.push(key);
    }
    keys.sort();

    for (var i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (m.hasOwnProperty(k))
        els.push(k + "=" + m[k]);
    }

    return {
      url: url.resolve(baseUrl, 'tradingApi'),
      body: els.join("&"),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Key": this._api_key,
        "Sign": crypto.createHmac("sha512", this._secretKey).update(els.join("&")).digest("hex")
      },
      method: "POST"
    };
  };

  constructor(config : Config.ConfigProvider) {
    this._api_key = config.GetString("PoloniexApiKey");
    this._secretKey = config.GetString("PoloniexSecretKey");
  }
}

class PoloniexHttp {
  post = <T>(actionUrl: string, msg : SignedMessage) : Promise<Models.Timestamped<T>> => {
    var d = Promises.defer<Models.Timestamped<T>>();

    request(this._signer.signMessage(this._baseUrl, actionUrl, msg), (err, resp, body) => {
      if (err) d.reject(err);
      else {
        try {
          var t = new Date();
          var data = JSON.parse(body);
          d.resolve(new Models.Timestamped(data, t));
        }
        catch (e) {
          console.error(new Date().toISOString().slice(11, -1), 'poloniex', err, 'url:', actionUrl, 'err:', err, 'body:', body);
          d.reject(e);
        }
      }
    });

    return d.promise;
  };

  get = <T>(actionUrl: string) : Promise<Models.Timestamped<T>> => {
    var d = Promises.defer<Models.Timestamped<T>>();

    request({
      url: url.resolve(this._baseUrl, 'public?command=return'+actionUrl),
      headers: {},
      method: "GET"
    }, (err, resp, body) => {
      if (err) d.reject(err);
      else {
        try {
          var t = new Date();
          var data = JSON.parse(body);
          d.resolve(new Models.Timestamped(data, t));
        }
        catch (e) {
          console.error(new Date().toISOString().slice(11, -1), 'poloniex', err, 'url:', actionUrl, 'err:', err, 'body:', body);
          d.reject(e);
        }
      }
    });

    return d.promise;
  };

  private _baseUrl : string;
  constructor(config : Config.ConfigProvider, private _signer: PoloniexMessageSigner) {
    this._baseUrl = config.GetString("PoloniexHttpUrl");
  }
}

class PoloniexPositionGateway implements Interfaces.IPositionGateway {
  PositionUpdate = new Utils.Evt<Models.CurrencyPosition>();

  private trigger = () => {
    this._http.post("CompleteBalances", {}).then(msg => {
      const symbols: string[] = this._symbolProvider.symbol.split('_');
      for (var i = symbols.length;i--;) {
        if (!(<any>msg.data) || !(<any>msg.data)[symbols[i]])
          console.error(new Date().toISOString().slice(11, -1), 'poloniex', 'Please change the API Key or contact support team of Poloniex, your API Key does not work because was not possible to retrieve your real wallet position; the application will probably crash now.');
        this.PositionUpdate.trigger(new Models.CurrencyPosition(parseFloat((<any>msg.data)[symbols[i]].available), parseFloat((<any>msg.data)[symbols[i]].onOrders), Models.toCurrency(symbols[i])));
      }
    });
  };

  constructor(private _http : PoloniexHttp, private _symbolProvider: PoloniexSymbolProvider) {
    setInterval(this.trigger, 15000);
    setTimeout(this.trigger, 10);
  }
}

class PoloniexBaseGateway implements Interfaces.IExchangeDetailsGateway {
  public get hasSelfTradePrevention() {
    return false;
  }

  name() : string {
    return "Poloniex";
  }

  makeFee() : number {
    return 0.001;
  }

  takeFee() : number {
    return 0.002;
  }

  exchange() : Models.Exchange {
    return Models.Exchange.Poloniex;
  }

  constructor(public minTickIncrement: number, public minSize: number) {}
}

class PoloniexSymbolProvider {
  public symbol: string;

  constructor(pair: Models.CurrencyPair) {
    this.symbol = Models.fromCurrency(pair.quote) + "_" + Models.fromCurrency(pair.base);
  }
}

class Poloniex extends Interfaces.CombinedGateway {
  constructor(config : Config.ConfigProvider, pair: Models.CurrencyPair) {
    var symbol = new PoloniexSymbolProvider(pair);
    var signer = new PoloniexMessageSigner(config);
    var http = new PoloniexHttp(config, signer);
    var socket = new PoloniexWebsocket(config, symbol);

    var orderGateway =
    // config.GetString("PoloniexOrderDestination") == "Poloniex"
      // ? <Interfaces.IOrderEntryGateway>new PoloniexOrderEntryGateway(http, signer, symbol)
      // :
      new NullGateway.NullOrderGateway();

    var minTick = 0.01;
    var minSize = 0.01;
    http.get('Ticker').then(msg => {
      if (!(<any>msg.data)[symbol.symbol]) return;
      const precisePrice = parseFloat((<any>msg.data)[symbol.symbol].last).toPrecision(6).toString();
      minTick = parseFloat('1e-'+precisePrice.substr(0, precisePrice.length-1).concat('1').replace(/^-?\d*\.?|0+$/g, '').length);
    });

    super(
      new PoloniexMarketDataGateway(socket, symbol),
      orderGateway,
      new PoloniexPositionGateway(http, symbol),
      new PoloniexBaseGateway(minTick, minSize)
    );
  }
}

export async function createPoloniex(config: Config.ConfigProvider, pair: Models.CurrencyPair): Promise<Interfaces.CombinedGateway> {
  return new Poloniex(config, pair);
}