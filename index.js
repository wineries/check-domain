var dns         = require('dns');
var util        = require("util");
var async       = require("async");
var request     = require('request');
var ping        = require('ping');
var moment      = require('moment');
var _           = require('underscore');
var URI         = require('urijs');
var serp        = require('serp');
var log         = require('crawler-ninja-logger').Logger;



var URL_WHOIS = "https://www.whoisxmlapi.com/whoisserver/WhoisService";
var URL_MAJESTIC_GET_INFO = "http://api.majestic.com/api/json";
var URL_SEMRUSH_GET_DATA = "http://api.semrush.com/";

var PARAM_COMMAND_AVAILABLE = "GET_DN_AVAILABILITY";

var REDEMPTION_PERIOD = "redemptionPeriod";
var PENDING_DELETE = "pendingDelete";
var INVALID_DOMAIN_MESSAGE = "Unable to retrieve whois record for";
var MISSING_WHOIS_DATA_MESSAGE = "MISSING_WHOIS_DATA";

/**
 * Check informations on a domain
 * - DNS resolve
 * - Ping
 * - Backlinks, Truts Flow provided by the Majestic API
 * - Availability provided by whoisxmlapi.com
 * - Whois provided by whoisxmlapi.com
 * - Check if indexed by Google (primary & secondary index)
 *
 * @param a json object {domain, majecticKey, whois : {user, password}, checkIfAlive, minTrustFlow},
          The majesticKey is optional
          The whois is also optional. It match to whoisxmlapi.com API credential
          noCheckIfDNSResolve : if true, the majestic & the whois data are not retrieved if there is a correct DNS resolved
          minTrustFlow : the min trustflow value required to retrieve availability and whois data
 * @param callback(error, result). The result is a json object containing the following attributes :
 *  - domain,
 *  - isDNSFound,
 *  - ips : list IPS({adress, isAlive}) used for this domain,
 *  - majestic (matching to the json result provided by the Majestic method GetIndexItemInfo  : DataTables.Results.Data[0]),
 *  - semrush data
 *  - isAvailable(true or false)
 *  - whois (matching to the json structure provided by the whoisxmlapi).
 *     for reasons of simplicity, it contains also extras attributes :
 *     missingData : if true, there is no whois date for this domain
 *     isValidDomain : the domain name is not valid
 *     isPendingDelete : true if the domain is pending delete
 *     isRedemptionPeriod : True id the domain is in redemption period
 *     redemptionPeriod
 *     createdDate
 *     expiresDate
 *     expiredWaitingTime
 */
module.exports = function (options, endCallback) {

  async.waterfall([
      function(callback) {
          getIp(options, callback);
      },
      function(data, callback) {
          getPing(data, callback);
      },
      function(data, callback) {
          getMajesticData(data, options, callback);
      },
      function(data, callback) {
          getOtherMetrics(data, options, callback);
      }
  ], function (error, data) {
      if (error) {
        logError("Error when checking domain", options.domain, error );
      }
      else {
        logInfo("End of checking domain", options.domain, data);
      }
      endCallback(error, data);
  });
};

function getIp(options, endCallback) {

    async.waterfall([
        function(callback) {
            lookup(options.domain, false, callback);
        },
        function(data, callback) {
            if (data.isDNSFound) {
              return callback(null, data);
            }
            lookup(options.domain, true, callback);
        }
    ], function (error, data) {
        endCallback(error, data);
    });

}



function lookup(domain, withWWW, callback) {
    dns.lookup(withWWW ? "www." + domain : domain, function(error, address){

          var data = {domain : domain, withWWW : withWWW};

          if (error) {
              data.isDNSFound = false;
          }
          else {
              data.isDNSFound = true;
              data.ip = address;
          }

          callback(null, data);
    });
}


function getPing(dnsInfo, callback) {

    if (! dnsInfo.isDNSFound) {
        dnsInfo.isAlive = false;
        return callback(null, dnsInfo);
    }

    ping.sys.probe(dnsInfo.ip, function(isAlive){
            dnsInfo.isAlive = isAlive;
            callback(null, dnsInfo);
    });

}

function getOtherMetrics(generalInfo, options, callback) {
  async.parallel([
    async.apply(getWhoisData, generalInfo, options),
    async.apply(getSemrushData, generalInfo, options),
    async.apply(getIndexedPages, options, true),
    async.apply(getIndexedPages, options, false)

  ], function(error, results){
      if (error) {
        return callback(error);
      }

      var data = generalInfo;

      if (results[0]) {
        data.whois = results[0];
      }

      if (results[0]) {
        if (data.isDNSFound) {
          data.isAvailable = false;
        }
        else {
          if (data.whois && data.whois.status) {
            data.isAvailable = (data.whois.status === "AVAILABLE");
          }
          else {
            data.isAvailable = false;
          }

        }

      }

      if (results[1]) {
        data.semrush = results[1];
      }

      if (results[2]) {
        data.primaryIndex = results[2];
      }

      if (results[3]) {
        data.googleIndex = results[3];
        data.secondaryIndex = data.googleIndex - data.primaryIndex;
      }

      data.tld = getTld(options.domain);
      callback(null, data);
  });

}


function getWhoisData(generalInfo, options, callback) {


  if (options.noCheckIfDNSResolve && generalInfo.isDNSFound) {
      let result = emptyWhoisData();
      return callback(null, result);
  }

  if (options.minTrustFlow && generalInfo.majestic.TrustFlow < options.minTrustFlow) {
      let result = emptyWhoisData();
      return callback(null, result);
  }

  if (options.whois && options.whois.user && options.whois.password) {
      var query = {
          url : URL_WHOIS,
          qs : {
            username : options.whois.user,
            password : options.whois.password,
            domainName : options.domain,
            outputFormat : "JSON"
          }
      };

      query.qs.getMode = "DNS_AND_WHOIS";

      request(query, function (error, response, body) {
          if (error) {
            logError( "whoisxmlapi request error, return empty whois data", options.domain, error);
            return callback(null, emptyWhoisData());
          }
          if (response.statusCode === 200) {

            var info = JSON.parse(body);

            // Check if the domains is valid
            if (info.ErrorMessage && info.ErrorMessage.msg.indexOf(INVALID_DOMAIN_MESSAGE) > -1) {
              info.isValidDomain = false;
            }
            else {
              info.isValidDomain = true;
            }

            // Check if there a whois data for this domain
            if (info.WhoisRecord && info.WhoisRecord.dataError && info.WhoisRecord.dataError === MISSING_WHOIS_DATA_MESSAGE) {
              info.missingData = true;
            }
            else {
              info.missingData = false;
            }

            // Check is the domain is pending deleted
            if (info.WhoisRecord && info.WhoisRecord.registryData && info.WhoisRecord.registryData.status) {
                info.status = info.WhoisRecord.registryData.status;
                info.isPendingDelete = info.WhoisRecord.registryData.status.indexOf(PENDING_DELETE) > -1;
                info.isRedemptionPeriod = info.WhoisRecord.registryData.status.indexOf(REDEMPTION_PERIOD) > -1;
            }
            else {
              info.isPendingDelete = 'no-data';
              info.isRedemptionPeriod = 'no-data';
            }

            // Check created date
            if (info.WhoisRecord && info.WhoisRecord.createdDate) {
              info.createdDate = info.WhoisRecord.createdDate;
            }
            else {
              info.createdDate = 'no-data';
            }

            // Check expires date
            if (info.WhoisRecord && info.WhoisRecord.expiresDate ) {
              info.expiresDate = info.WhoisRecord.expiresDate;
              info.expiredWaitingTime = moment(info.WhoisRecord.expiresDate, moment.ISO_8601).fromNow();
            }
            else {
              info.expiresDate = 'no-data';
              info.expiredWaitingTime = 'no-data';
            }

            // Check domain age
            if (info.WhoisRecord && info.WhoisRecord.estimatedDomainAge ) {
              info.estimatedDomainAge = (info.WhoisRecord.estimatedDomainAge / 365).toFixed(2);
            }
            else {
              info.estimatedDomainAge = 'no-data';
            }

            return callback(null, info);
          }
          else {
            error = new Error("Impossible to get the Whoisxmlapi data, check your credential !");
            logError("Whoisxmlapi http request error : " + response.statusCode, options.domain, error);
            callback(null, emptyWhoisData());
          }
      });
  }
  else {
    callback(null, emptyWhoisData());
  }

}

function getMajesticData(generalInfo, options, callback) {
    if (options.majecticKey) {
        var query = {
           url : URL_MAJESTIC_GET_INFO,
           qs : {
             cmd : "GetIndexItemInfo",
             datasource : "fresh",
             app_api_key : options.majecticKey,
             items : 1,
             item0 : options.domain
           }
        };

        if (options.noCheckIfDNSResolve && generalInfo.isDNSFound) {
          generalInfo.majestic = {"TrustFlow" : 0, "ResultCode" : "N0-CHECK-DNS-RESOLVED"};
          return callback(null, generalInfo);
        }

        request(query, function (error, response, body) {
            if (error) {
              logError("Majestic request error", options.domain, error);
              return callback(error);
            }

            if (response.statusCode === 200) {
              var info = JSON.parse(body);
              generalInfo.majestic = info.DataTables.Results.Data[0];
              callback(null, generalInfo);
            }
            else {
              error = new Error("Impossible to get the Majestic data, check your credential");
              logError("Majestic http request error : " + response.statusCode, options.domain, error);
              callback(error);
            }
        });
    }
    else {
      generalInfo.majestic = {"TrustFlow" : 0, "ResultCode" : "NO-MAJESTIC-KEY"}; //Dummy json if there is no majesticKey
      callback(null, generalInfo);
    }
}

function getSemrushData(generalInfo, options, callback) {


    if (options.semrushKey) {

        var query = {
           url : URL_SEMRUSH_GET_DATA,
           qs : {
             type : "domain_rank",
             key : options.semrushKey,
             export_columns : "Dn,Rk,Or,Ot,Oc,Ad,At,Ac",
             "domain" : options.domain,
             "database" : options.semrushDB || "us"
           }
        };

        if (options.noCheckIfDNSResolve && generalInfo.isDNSFound) {
          return callback(null, emptySemrush());
        }

        if (options.minTrustFlow && generalInfo.majestic.TrustFlow < options.minTrustFlow) {
            return callback(null, emptySemrush());
        }

        request(query, function (error, response, body) {
            if (error) {
              logError("Semrush request error", options.domain, error);
              return callback(error);
            }

            if (response.statusCode === 200) {
              callback(null, convertSemrush(body));
            }
            else {
              error = new Error("Impossible to get the semrush data, check your credential");
              logError("Semrush http request error : " + response.statusCode, options.domain, error);
              callback(error);
            }
        });
    }
    else {
      callback(null, emptySemrush());
    }
}

function getIndexedPages(options, fromPrimaryIndex, callback) {

  var opts = {
    host : options.host,
    numberOfResults : true,
    qs : {
      q   : "site:" + options.domain + (fromPrimaryIndex ? " /&" : "")
    },
    proxyList : options.proxyList
  };

  serp.search(opts, callback);

}

function getTld(domain) {
    console.log("getTld", domain);
    return new URI("http://" + domain).tld();
}

function emptyWhoisData() {
  return {
      missingData : "true",
      isValidDomain : "no-data",
      isPendingDelete : "no-data",
      isRedemptionPeriod : "no-data",
      createdDate : 'no-data',
      expiresDate : 'no-data',
      expiredWaitingTime : 'no-data',
      estimatedDomainAge : 'no-data'
  };
}

function convertSemrush(semrushResponse) {

  var result = semrushResponse.split("\r\n");
  if (result.length < 2) {
    return emptySemrush();
  }
  var response =  result[1].split(";");
  return {
    rank : response[1],
    oganicKeywords : response[2],
    organicTraffic : response[3],
    organicCost: response[4],
    adwordsKeywords: response[5],
    adwordsTraffic : response[6],
    adwordsCost : response[7]
  };

}

function emptySemrush() {
  return {
    rank : -1,
    oganicKeywords : 0,
    organicTraffic : 0,
    organicCost: 0,
    adwordsKeywords: 0,
    adwordsTraffic : 0,
    adwordsCost : 0
  };

}

function logInfo(message, domain, options) {
  log.info({module : "check-domains", message : message, domain : domain, options : options});
}

function logError(message, domain, options, error) {
  log.error({module : "check-domains", message : message, domain : domain , error : error, options});
}
