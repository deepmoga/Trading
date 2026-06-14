const axios = require('axios');

const DHAN_BASE = 'https://api.dhan.co';
const AUTH_BASE = 'https://auth.dhan.co';

function getHeaders() {
  return {
    'access-token': process.env.DHAN_ACCESS_TOKEN || '',
    'client-id':    process.env.DHAN_CLIENT_ID    || '',
    'Content-Type': 'application/json',
  };
}

async function dhanGet(path) {
  const res = await axios.get(DHAN_BASE + path, { headers: getHeaders(), timeout: 10000 });
  return res.data;
}

async function dhanPost(path, body) {
  const res = await axios.post(DHAN_BASE + path, body, { headers: getHeaders(), timeout: 10000 });
  return res.data;
}

async function getFunds() {
  return dhanGet('/v2/fundlimit');
}

async function getPositions() {
  return dhanGet('/v2/positions');
}

async function getTradebook(fromDate, toDate) {
  return dhanGet(`/v2/tradebook?from-date=${fromDate}&to-date=${toDate}`);
}

// body: { IDX_I: ['13','25'], MCX_FO: ['626'], NSE_FNO: [...] }
async function getQuotes(body) {
  return dhanPost('/v2/marketfeed/quote', body);
}

// Intraday candles — resolution: '1','5','15','25','60'
// exchangeSegment: IDX_I | NSE_FNO | MCX_FO | NSE_EQ | BSE_EQ
// instrument: INDEX | FUTIDX | FUTSTK | FUTCOM | OPTIDX
async function getHistoricalData(securityId, exchangeSegment, instrument, fromDate, toDate, resolution) {
  const body = {
    securityId:      String(securityId),
    exchangeSegment,
    instrument,
    fromDate,
    toDate,
    resolution:      String(resolution),
  };
  return dhanPost('/v2/charts/intraday', body);
}

// Daily/weekly candles
async function getHistoricalDaily(securityId, exchangeSegment, instrument, fromDate, toDate) {
  const body = {
    securityId:      String(securityId),
    exchangeSegment,
    instrument,
    fromDate,
    toDate,
  };
  return dhanPost('/v2/charts/historical', body);
}

async function placeOrder(params) {
  // params: { dhanClientId, transactionType, exchangeSegment, productType,
  //           orderType, validity, tradingSymbol, securityId, quantity, price, triggerPrice }
  return dhanPost('/v2/orders', params);
}

async function getOrders() {
  return dhanGet('/v2/orders');
}

async function cancelOrder(orderId) {
  const res = await axios.delete(`${DHAN_BASE}/v2/orders/${orderId}`, { headers: getHeaders() });
  return res.data;
}

// ── OAUTH / CONSENT FLOW (API Key + Secret → Access Token) ─────────────────────
// Docs: https://dhanhq.co/docs/v2/authentication/
// Step 1: generate-consent  → returns consentAppId
// Step 2: user opens login URL in browser, logs in, redirected with tokenId
// Step 3: consumeApp-consent with tokenId → returns accessToken

async function generateConsent(clientId, apiKey, apiSecret) {
  const res = await axios.post(`${AUTH_BASE}/app/generate-consent`, null, {
    params: { client_id: clientId },
    headers: { app_id: apiKey, app_secret: apiSecret },
    timeout: 10000,
  });
  return res.data;
}

async function consumeConsent(tokenId, apiKey, apiSecret) {
  const res = await axios.post(`${AUTH_BASE}/app/consumeApp-consent`, null, {
    params: { tokenId },
    headers: { app_id: apiKey, app_secret: apiSecret },
    timeout: 10000,
  });
  return res.data;
}

module.exports = {
  getFunds,
  getPositions,
  getTradebook,
  getQuotes,
  getHistoricalData,
  getHistoricalDaily,
  placeOrder,
  getOrders,
  cancelOrder,
  generateConsent,
  consumeConsent,
};
