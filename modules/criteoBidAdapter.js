import { loadExternalScript } from 'src/adloader';
import { registerBidder } from 'src/adapters/bidderFactory';
import { parse } from 'src/url';
import * as utils from 'src/utils';

const ADAPTER_VERSION = 5;
const BIDDER_CODE = 'criteo';
const CDB_ENDPOINT = '//bidder.criteo.com/cdb';
const CRITEO_VENDOR_ID = 91;
const INTEGRATION_MODES = {
  'amp': 1,
};
const PROFILE_ID = 207;

// Unminified source code can be found in: https://github.com/Prebid-org/prebid-js-external-js-criteo/blob/master/dist/prod.js
const PUBLISHER_TAG_URL = '//static.criteo.net/js/ld/publishertag.prebid.js';

const FAST_BID_PUBKEY = {
  "kty": "RSA",
  "n": "ztQYwCE5BU7T9CDM5he6rKoabstXRmkzx54zFPZkWbK530dwtLBDeaWBMxHBUT55CYyboR_EZ4efghPi3CoNGfGWezpjko9P6p2EwGArtHEeS4slhu_SpSIFMjG6fdrpRoNuIAMhq1Z-Pr_-HOd1pThFKeGFr2_NhtAg-TXAzaU",
  "e": "AQAB",
  "alg": "RS256",
  "use": "sig"
};

/** @type {BidderSpec} */
export const spec = {
  code: BIDDER_CODE,

  /**
   * @param {object} bid
   * @return {boolean}
   */
  isBidRequestValid: bid => (
    !!(bid && bid.params && (bid.params.zoneId || bid.params.networkId))
  ),

  /**
   * @param {BidRequest[]} bidRequests
   * @param {*} bidderRequest
   * @return {ServerRequest}
   */
  buildRequests: (bidRequests, bidderRequest) => {
    let url;
    let data;

    // If publisher tag not already loaded try to get it from fast bid
    if (!publisherTagAvailable()) {
      window.Criteo = window.Criteo || {};
      window.Criteo.usePrebidEvents = false;

      tryGetCriteoFastBid();

      // Reload the PublisherTag after the timeout to ensure FastBid is up-to-date and tracking done properly
      setTimeout(() => {
        loadExternalScript(PUBLISHER_TAG_URL, BIDDER_CODE);
      }, bidderRequest.timeout);
    }

    if (publisherTagAvailable()) {
      const adapter = new Criteo.PubTag.Adapters.Prebid(PROFILE_ID, ADAPTER_VERSION, bidRequests, bidderRequest);
      url = adapter.buildCdbUrl();
      data = adapter.buildCdbRequest();
    } else {
      const context = buildContext(bidRequests);
      url = buildCdbUrl(context);
      data = buildCdbRequest(context, bidRequests, bidderRequest);
    }

    if (data) {
      return { method: 'POST', url, data, bidRequests };
    }
  },

  /**
   * @param {*} response
   * @param {ServerRequest} request
   * @return {Bid[]}
   */
  interpretResponse: (response, request) => {
    const body = response.body || response;

    if (publisherTagAvailable()) {
      const adapter = Criteo.PubTag.Adapters.Prebid.GetAdapter(request);
      if (adapter) {
        return adapter.interpretResponse(body, request);
      }
    }

    const bids = [];

    if (body && body.slots && utils.isArray(body.slots)) {
      body.slots.forEach(slot => {
        const bidRequest = request.bidRequests.find(b => b.adUnitCode === slot.impid && b.params.zoneId === slot.zoneid);
        const bidId = bidRequest.bidId;
        const bid = {
          requestId: bidId,
          cpm: slot.cpm,
          currency: slot.currency,
          netRevenue: true,
          ttl: slot.ttl || 60,
          creativeId: bidId,
          width: slot.width,
          height: slot.height,
        }
        if (slot.native) {
          bid.ad = createNativeAd(bidId, slot.native, bidRequest.params.nativeCallback);
        } else {
          bid.ad = slot.creative;
        }
        bids.push(bid);
      });
    }

    return bids;
  },

  /**
   * @param {TimedOutBid} timeoutData
   */
  onTimeout: (timeoutData) => {
    if (publisherTagAvailable()) {
      const adapter = Criteo.PubTag.Adapters.Prebid.GetAdapter(timeoutData.auctionId);
      adapter.handleBidTimeout();
    }
  },
};

/**
 * @return {boolean}
 */
function publisherTagAvailable() {
  return typeof Criteo !== 'undefined' && Criteo.PubTag && Criteo.PubTag.Adapters && Criteo.PubTag.Adapters.Prebid;
}

/**
 * @param {BidRequest[]} bidRequests
 * @return {CriteoContext}
 */
function buildContext(bidRequests) {
  const url = utils.getTopWindowUrl();
  const queryString = parse(url).search;

  const context = {
    url: url,
    debug: queryString['pbt_debug'] === '1',
    noLog: queryString['pbt_nolog'] === '1',
    integrationMode: undefined,
  };

  bidRequests.forEach(bidRequest => {
    if (bidRequest.params.integrationMode) {
      context.integrationMode = bidRequest.params.integrationMode;
    }
  })

  return context;
}

/**
 * @param {CriteoContext} context
 * @return {string}
 */
function buildCdbUrl(context) {
  let url = CDB_ENDPOINT;
  url += '?profileId=' + PROFILE_ID;
  url += '&av=' + String(ADAPTER_VERSION);
  url += '&cb=' + String(Math.floor(Math.random() * 99999999999));

  if (context.integrationMode in INTEGRATION_MODES) {
    url += '&im=' + INTEGRATION_MODES[context.integrationMode];
  }
  if (context.debug) {
    url += '&debug=1';
  }
  if (context.noLog) {
    url += '&nolog=1';
  }

  return url;
}

/**
 * @param {CriteoContext} context
 * @param {BidRequest[]} bidRequests
 * @return {*}
 */
function buildCdbRequest(context, bidRequests, bidderRequest) {
  let networkId;
  const request = {
    publisher: {
      url: context.url,
    },
    slots: bidRequests.map(bidRequest => {
      networkId = bidRequest.params.networkId || networkId;
      const slot = {
        impid: bidRequest.adUnitCode,
        transactionid: bidRequest.transactionId,
        auctionId: bidRequest.auctionId,
        sizes: bidRequest.sizes.map(size => size[0] + 'x' + size[1]),
      };
      if (bidRequest.params.zoneId) {
        slot.zoneid = bidRequest.params.zoneId;
      }
      if (bidRequest.params.publisherSubId) {
        slot.publishersubid = bidRequest.params.publisherSubId;
      }
      if (bidRequest.params.nativeCallback) {
        slot.native = true;
      }
      return slot;
    }),
  };
  if (networkId) {
    request.publisher.networkid = networkId;
  }
  if (bidderRequest && bidderRequest.gdprConsent) {
    request.gdprConsent = {
      gdprApplies: !!(bidderRequest.gdprConsent.gdprApplies),
      consentData: bidderRequest.gdprConsent.consentString,
      consentGiven: !!(bidderRequest.gdprConsent.vendorData && bidderRequest.gdprConsent.vendorData.vendorConsents &&
        bidderRequest.gdprConsent.vendorData.vendorConsents[ CRITEO_VENDOR_ID.toString(10) ]),
    };
  }
  return request;
}

/**
 * @param {string} id
 * @param {*} payload
 * @param {*} callback
 * @return {string}
 */
function createNativeAd(id, payload, callback) {
  // Store the callback and payload in a global object to be later accessed from the creative
  window.criteo_prebid_native_slots = window.criteo_prebid_native_slots || {};
  window.criteo_prebid_native_slots[id] = { callback, payload };

  // The creative is in an iframe so we have to get the callback and payload
  // from the parent window (doesn't work with safeframes)
  return `<script type="text/javascript">
    var win = window;
    for (var i = 0; i < 10; ++i) {
      win = win.parent;
      if (win.criteo_prebid_native_slots) {
        var responseSlot = win.criteo_prebid_native_slots["${id}"];
        responseSlot.callback(responseSlot.payload);
        break;
      }
    }
  </script>`;
}

function str2ab(str) {
  var buf = new ArrayBuffer(str.length);
  var bufView = new Uint8Array(buf);
  for(var i = 0; i < str.length; ++i) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
}

function cryptoVerify(algo, key, hash, code, callback) {
  // Standard
  const standardSubtle = window.crypto && (window.crypto.subtle || window.crypto.webkitSubtle);
  if (standardSubtle) {
    window.crypto.subtle.importKey('jwk', key, algo, false, ['verify']).then(
      (cryptoKey) => {
        standardSubtle.verify(algo, cryptoKey, str2ab(atob(hash)), str2ab(code)).then(
          callback,
          (error) => { callback(false); },
        );
      },
      (error) => { callback(undefined); },
    );
    return;
  }

  // IE11
  if (window.msCrypto) {
    const eImport = window.msCrypto.subtle.importKey('jwk', str2ab(JSON.stringify(key)), algo, false, ['verify']);
    eImport.onerror = (evt) => { callback(undefined); };
    eImport.oncomplete = (evtKey) => {
      const cryptoKey = evtKey.target.result;
      const eVerify = window.msCrypto.subtle.verify(algo, cryptoKey, str2ab(atob(hash)), str2ab(code));
      eVerify.onerror = (evt) => { callback(false); };
      eVerify.oncomplete = (evt) => { callback(evt.target.result); };
    };
    return;
  }

  // No crypto lib found
  callback(undefined);
}

function validateFastBid(fastBid, callback) {
  // The value stored must contain the file's encrypted hash as first line
  const firstLineEnd = fastBid.indexOf('\n');
  const firstLine = fastBid.substr(0, firstLineEnd).trim();
  if (firstLine.substr(0, 9) !== '// Hash: ') {
    utils.logWarn('No hash found in FastBid');
    callback(false);
  }

  // Remove the hash part from the locally stored value
  const fileEncryptedHash = firstLine.substr(9);
  const publisherTag = fastBid.substr(firstLineEnd + 1);

  // Verify the hash using cryptography
  const algo = {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256',
  };
  try {
    cryptoVerify(algo, FAST_BID_PUBKEY, fileEncryptedHash, publisherTag, callback);
  } catch (e) {
    utils.logWarn('Failed to verify Criteo FastBid');
    callback(undefined);
  }
}

/**
 * @return {boolean}
 */
function tryGetCriteoFastBid() {
  try {
    const fastBid = localStorage.getItem('criteo_fast_bid');
    if (fastBid !== null) {
      validateFastBid(fastBid, (valid) => {
        if (valid === false) {
          utils.logWarn('Invalid Criteo FastBid found');
          localStorage.removeItem('criteo_fast_bid');
        } else {
          utils.logInfo('Using Criteo FastBid');
          eval(fastBid); // eslint-disable-line no-eval
        }
      });
    }
  } catch (e) {
    // Unable to get fast bid
  }
}

registerBidder(spec);
