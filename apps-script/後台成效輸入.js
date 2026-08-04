/****************************************************
 * 成效輸入整合版
 * API 三端資料 + channel_code 對照
 * HYC GA：總活躍用戶 + 總下載點擊
 * 其他站點 GA：事件計數 = firstUserSource=dh + eventName 包含 广告点击
 *
 * 本版邏輯：
 * 改成抓「最近 N 個完整週」
 *
 * 例如今天 2026/05/18 週一
 * WEEK_RANGE_COUNT = 2 時，會抓：
 * 1. 2026/05/03 ~ 2026/05/09
 * 2. 2026/05/10 ~ 2026/05/16
 ****************************************************/

var CONFIG = {
  KEY: "n7kp3mxr9jlz5bqv",
  BASE_URL: "https://opdata2026.top/api/",
  SPREADSHEET_ID: "1WBbeysNvCfsi9o1emFSulZEz9AWjWIDusT6qvx2MqRA",
  SHEET_NAME: "成效輸入",

  API_ENDPOINT: "daily_and_install_statistics",
  CHANNEL_ENDPOINT_PREFIX: "get_channels/",
  PRODUCT_KEYS_INSTALL: ["avnight", "hyc", "jjkk"],

  // 要抓最近幾個「完整週」
  // 2 = 最近兩週，每週各自一段，不會合併
  WEEK_RANGE_COUNT: 2,

  // API 分批天數
  // 這裡設 7，剛好一週一批
  BATCH_DAYS: 7,

  SLEEP_MS: 150,

  GA_LIMIT: 100000,

  HYC_GA: {
    H5_PROPERTY_ID: "253465323",
    ANDROID_PROPERTY_ID: "425210635",
    H5_MEDIUM_DIMENSION: "firstUserMedium",
    ANDROID_DOWNLOAD_DIMENSION: "customEvent:download_mkt",
    DOWNLOAD_EVENT_NAME: "下载成功总点击"
  },

  SITE_GA_LIST: [
    { product: "PJ8", groupName: "破解吧", propertyId: "492055326" },
    { product: "ZFB", groupName: "汁婦寶", propertyId: "492031396" },
    { product: "OJI", groupName: "萬精游", propertyId: "492034107" },
    { product: "MYS", groupName: "磨欲爽", propertyId: "492027266" },
    { product: "XRK", groupName: "色軟庫", propertyId: "492034111" },
    { product: "BS", groupName: "熊貓", propertyId: "492095061" }
  ],

  HEADERS: [
    "資料起始日",
    "資料結束日",
    "廣告代碼",
    "對應產品",
    "廣告分組",
    "不重複安裝數",
    "廠商安裝",
    "不重複首頁開啟數",
    "不重複活躍用戶數",
    "首儲訂單數",
    "首儲購買金額",
    "加總訂單數",
    "加總購買金額",
    "所有渠道不重複安裝數",
    "所有渠道不重複活躍用戶數",
    "總活躍用戶",
    "總下載點擊",
    "事件計數"
  ]
};


/****************************************************
 * 主流程
 ****************************************************/

function run_寫入成效輸入() {
  var ranges = getWeeklyRanges_();

  Logger.log("執行區間數量：" + ranges.length);
  ranges.forEach(function(r, i) {
    Logger.log("區間 " + (i + 1) + "：" + r.start + " ~ " + r.end);
  });

  var channelCodeMap = buildAllChannelCodeMap_();
  var allFinalRows = [];

  ranges.forEach(function(range) {
    Logger.log("========== 開始處理區間：" + range.start + " ~ " + range.end + " ==========");

    var apiRows = fetchAllApiInstallRows_(range.start, range.end);
    Logger.log("API 原始筆數：" + apiRows.length);

    var apiMergedRows = mergeApiRowsForOutput_(apiRows, channelCodeMap);
    Logger.log("API 合併後筆數：" + apiMergedRows.length);

    var hycGaMap = buildHycGaMap_(range.start, range.end);
    Logger.log("HYC GA 渠道數：" + Object.keys(hycGaMap).length);

    var siteGaRows = buildSiteGaRows_(range.start, range.end);
    Logger.log("其他站點 GA 筆數：" + siteGaRows.length);

    var finalRows = [];

    apiMergedRows.forEach(function(row) {
      var hycGa = hycGaMap[row.channelKey] || {
        activeUsers: "",
        downloadClicks: ""
      };

      finalRows.push([
        range.start,
        range.end,
        row.channelCode,
        row.product,
        row.groupName,
        row.channel_unique_installed_counts,
        row.external_channel_unique_installed_counts,
        row.all_channel_unique_viewer_counts,
        row.channel_active_unique_counts,
        row.firstOrders,
        row.firstAmount,
        row.totalOrders,
        row.totalAmount,
        row.all_channel_unique_installed_counts,
        row.all_channel_unique_active_counts,
        row.product === "HYC"
        ? toNumberOrZero_(row.channel_active_unique_counts) + toNumberOrZero_(hycGa.activeUsers)
        : "",
        row.product === "HYC" ? hycGa.downloadClicks : "",
        ""
      ]);
    });

    finalRows = finalRows.concat(siteGaRows);

    Logger.log(
      "區間完成：" +
      range.start +
      " ~ " +
      range.end +
      " / 筆數：" +
      finalRows.length
    );

    allFinalRows = allFinalRows.concat(finalRows);
  });

  allFinalRows.sort(compareOutputRows_);

  writeOutputByReplacingRanges_(ranges, allFinalRows);

  Logger.log("✅ 成效輸入完成，共寫入：" + allFinalRows.length + " 筆");
}


/****************************************************
 * 觸發器
 ****************************************************/

function createDaily1130Trigger_成效輸入() {
  deleteTriggerByFunctionName_("run_寫入成效輸入");

  ScriptApp.newTrigger("run_寫入成效輸入")
    .timeBased()
    .everyDays(1)
    .atHour(11)
    .nearMinute(30)
    .create();

  Logger.log("已建立每天 11:30 成效輸入排程");
}

function deleteDaily1130Trigger_成效輸入() {
  deleteTriggerByFunctionName_("run_寫入成效輸入");
  Logger.log("已刪除成效輸入排程");
}


/****************************************************
 * API 簽名
 ****************************************************/

function md5Hex_(s) {
  var b = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    s,
    Utilities.Charset.UTF_8
  );

  return b.map(function(x) {
    var h = (x & 0xff).toString(16);
    return h.length === 1 ? "0" + h : h;
  }).join("");
}

function buildSignedUrl_(endpoint, params) {
  var t = new Date().getTime().toString();
  var secret = md5Hex_(CONFIG.KEY + t + CONFIG.KEY);

  var qs = [
    "time=" + encodeURIComponent(t),
    "secret=" + encodeURIComponent(secret)
  ];

  Object.keys(params).forEach(function(k) {
    qs.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
  });

  return CONFIG.BASE_URL + endpoint + "?" + qs.join("&");
}


/****************************************************
 * 渠道對照：channel_name → channel_code
 ****************************************************/

function buildAllChannelCodeMap_() {
  var result = {};

  CONFIG.PRODUCT_KEYS_INSTALL.forEach(function(productKey) {
    result[productKey] = fetchChannelCodeMap_(productKey);
    Logger.log(
      "渠道對照完成：" +
      productKey +
      " / " +
      Object.keys(result[productKey]).length +
      " 筆"
    );
  });

  return result;
}

function fetchChannelCodeMap_(productKey) {
  var endpoint = CONFIG.CHANNEL_ENDPOINT_PREFIX + encodeURIComponent(productKey);
  var url = CONFIG.BASE_URL + endpoint;

  var resp = UrlFetchApp.fetch(url, {
    method: "get",
    muteHttpExceptions: true,
    followRedirects: false,
    validateHttpsCertificates: true,
    headers: {
      Accept: "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0"
    }
  });

  var code = resp.getResponseCode();
  var text = resp.getContentText() || "";
  var trimmed = text.trim();

  if (code !== 200) {
    Logger.log("❌ get_channels 失敗：" + productKey + " / HTTP " + code);
    Logger.log(text.substring(0, 500));
    return {};
  }

  if (!trimmed || (trimmed.charAt(0) !== "{" && trimmed.charAt(0) !== "[")) {
    Logger.log("❌ get_channels 回傳不是 JSON：" + productKey);
    Logger.log(text.substring(0, 500));
    return {};
  }

  var json = JSON.parse(trimmed);
  var datas = json.datas || [];

  var map = {};

  datas.forEach(function(ch) {
    var channelName = String(ch.channel_name || "").trim();
    var channelCode = String(ch.channel_code || "").trim();
    var identifierCode = String(ch.channel_identifier_code || "").trim();

    if (!channelName || !channelCode) return;

    map[channelName] = channelCode;
    map[normalizeChannelCode_(channelName)] = channelCode;

    if (identifierCode) {
      map[identifierCode] = channelCode;
      map[normalizeChannelCode_(identifierCode)] = channelCode;
    }
  });

  return map;
}


/****************************************************
 * 三端 API
 ****************************************************/

function fetchAllApiInstallRows_(startDate, endDate) {
  var allRows = [];

  CONFIG.PRODUCT_KEYS_INSTALL.forEach(function(productKey) {
    try {
      var rows = fetchApiReport_(
        CONFIG.API_ENDPOINT,
        productKey,
        startDate,
        endDate,
        0
      );

      rows.forEach(function(r) {
        r.product_key = productKey;
        allRows.push(r);
      });

      Logger.log("API 完成：" + productKey + " / " + rows.length + " 筆");
    } catch (e) {
      Logger.log("API 失敗：" + productKey + " / " + (e.stack || e.message));
    }
  });

  return allRows;
}

function fetchApiReport_(endpoint, productKey, startDate, endDate, expand) {
  var ranges = splitDateRange_(startDate, endDate, CONFIG.BATCH_DAYS);
  var allRows = [];

  ranges.forEach(function(r) {
    var url = buildSignedUrl_(endpoint, {
      product_key: productKey,
      "staticits_timestamp[start]": r.start,
      "staticits_timestamp[end]": r.end,
      expand: expand
    });

    Logger.log("API 抓取：" + endpoint + " / " + productKey + " / " + r.start + " ~ " + r.end);

    var resp = UrlFetchApp.fetch(url, {
      method: "get",
      muteHttpExceptions: true,
      followRedirects: false,
      validateHttpsCertificates: true,
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0"
      }
    });

    var code = resp.getResponseCode();
    var text = resp.getContentText() || "";
    var trimmed = text.trim();

    if (code !== 200) {
      Logger.log("❌ API HTTP 錯誤：" + code);
      Logger.log(text.substring(0, 500));
      throw new Error(endpoint + " HTTP " + code);
    }

    if (!trimmed) {
      Logger.log("⚠️ API 空回傳：" + productKey + " / " + r.start);
      return;
    }

    if (trimmed.charAt(0) !== "{" && trimmed.charAt(0) !== "[") {
      Logger.log("❌ API 回傳不是 JSON");
      Logger.log(text.substring(0, 500));
      throw new Error(endpoint + " 回傳不是 JSON，可能抓到登入頁、轉址頁或權限頁");
    }

    var json = JSON.parse(trimmed);
    var data = json.data || [];

    data.forEach(function(row) {
      Object.keys(row).forEach(function(k) {
        if (row[k] === null || row[k] === undefined) row[k] = "";
      });

      allRows.push(row);
    });

    if (CONFIG.SLEEP_MS > 0) Utilities.sleep(CONFIG.SLEEP_MS);
  });

  return allRows;
}

function mergeApiRowsForOutput_(rows, channelCodeMap) {
  var map = {};

  rows.forEach(function(r) {
    var channelName = String(r.channel_name || "").trim();
    if (!channelName) return;

    var productKey = r.product_key;
    var productChannelMap = channelCodeMap[productKey] || {};

    var channelCode =
      productChannelMap[channelName] ||
      productChannelMap[normalizeChannelCode_(channelName)] ||
      channelName;

    var channelKey = normalizeChannelCode_(channelCode);
    var groupName = String(r.group_name || "").trim();
    var product = mapApiProduct_(productKey, groupName);

    var key = [
      channelKey,
      product,
      groupName
    ].join("||");

    if (!map[key]) {
      map[key] = {
        channelCode: channelCode,
        channelKey: channelKey,
        product: product,
        groupName: groupName,

        channel_unique_installed_counts: 0,
        external_channel_unique_installed_counts: 0,
        all_channel_unique_viewer_counts: 0,
        channel_active_unique_counts: 0,
        firstOrders: 0,
        firstAmount: 0,
        totalOrders: 0,
        totalAmount: 0,
        all_channel_unique_installed_counts: 0,
        all_channel_unique_active_counts: 0
      };
    }

    var t = map[key];

    t.channel_unique_installed_counts += toNumberOrZero_(r.channel_unique_installed_counts);

    t.external_channel_unique_installed_counts += toNumberOrZero_(
      r.external_channel_unique_installed_counts !== undefined && r.external_channel_unique_installed_counts !== ""
        ? r.external_channel_unique_installed_counts
        : r.channel_installed_counts
    );

    t.all_channel_unique_viewer_counts += toNumberOrZero_(r.all_channel_unique_viewer_counts);
    t.channel_active_unique_counts += toNumberOrZero_(r.channel_active_unique_counts);
    t.firstOrders += toNumberOrZero_(r.firstOrders);
    t.firstAmount += toNumberOrZero_(r.firstAmount);
    t.totalOrders += toNumberOrZero_(r.totalOrders);
    t.totalAmount += toNumberOrZero_(r.totalAmount);
    t.all_channel_unique_installed_counts += toNumberOrZero_(r.all_channel_unique_installed_counts);
    t.all_channel_unique_active_counts += toNumberOrZero_(r.all_channel_unique_active_counts);
  });

  return Object.keys(map).map(function(k) {
    return map[k];
  });
}

function mapApiProduct_(productKey, groupName) {
  if (groupName === "AV9-其他") return "av9_poquan";
  if (groupName === "JK-其它" || groupName === "JK-其他") return "jk_poquan";

  var map = {
    avnight: "AV9",
    hyc: "HYC",
    jjkk: "JK"
  };

  return map[productKey] || productKey;
}


/****************************************************
 * HYC GA
 ****************************************************/

function buildHycGaMap_(startDate, endDate) {
  var result = {};

  var h5AndroidDownloadMap = fetchGaMap_({
    propertyId: CONFIG.HYC_GA.H5_PROPERTY_ID,
    dimensions: [CONFIG.HYC_GA.H5_MEDIUM_DIMENSION],
    metrics: ["eventCount"],
    startDate: startDate,
    endDate: endDate,
    dimensionFilter: {
      andGroup: {
        expressions: [
          {
            filter: {
              fieldName: "eventName",
              stringFilter: {
                matchType: "CONTAINS",
                value: CONFIG.HYC_GA.DOWNLOAD_EVENT_NAME,
                caseSensitive: false
              }
            }
          },
          {
            filter: {
              fieldName: "operatingSystem",
              stringFilter: {
                matchType: "EXACT",
                value: "Android",
                caseSensitive: false
              }
            }
          }
        ]
      }
    }
  });

  var h5ActiveUsersMap = fetchGaMap_({
    propertyId: CONFIG.HYC_GA.H5_PROPERTY_ID,
    dimensions: [CONFIG.HYC_GA.H5_MEDIUM_DIMENSION],
    metrics: ["activeUsers"],
    startDate: startDate,
    endDate: endDate
  });

  var androidDownloadMap = fetchGaMap_({
    propertyId: CONFIG.HYC_GA.ANDROID_PROPERTY_ID,
    dimensions: [CONFIG.HYC_GA.ANDROID_DOWNLOAD_DIMENSION],
    metrics: ["eventCount"],
    startDate: startDate,
    endDate: endDate,
    dimensionFilter: {
      filter: {
        fieldName: "eventName",
        stringFilter: {
          matchType: "CONTAINS",
          value: CONFIG.HYC_GA.DOWNLOAD_EVENT_NAME,
          caseSensitive: false
        }
      }
    }
  });

  var androidActiveUsersMap = fetchGaMap_({
    propertyId: CONFIG.HYC_GA.ANDROID_PROPERTY_ID,
    dimensions: [CONFIG.HYC_GA.ANDROID_DOWNLOAD_DIMENSION],
    metrics: ["activeUsers"],
    startDate: startDate,
    endDate: endDate
  });

  mergeMetricToHycResult_(result, h5AndroidDownloadMap, "downloadClicks");
  mergeMetricToHycResult_(result, androidDownloadMap, "downloadClicks");
  mergeMetricToHycResult_(result, h5ActiveUsersMap, "activeUsers");

  return result;
}

function mergeMetricToHycResult_(result, map, metricName) {
  Object.keys(map).forEach(function(channelKey) {
    if (!result[channelKey]) {
      result[channelKey] = {
        activeUsers: 0,
        downloadClicks: 0
      };
    }

    result[channelKey][metricName] += toNumberOrZero_(map[channelKey]);
  });
}


/****************************************************
 * 其他站點 GA
 ****************************************************/

function buildSiteGaRows_(startDate, endDate) {
  var rows = [];

  CONFIG.SITE_GA_LIST.forEach(function(site) {
    try {
      var map = fetchSiteAdClickGaEventCountMap_({
        propertyId: site.propertyId,
        startDate: startDate,
        endDate: endDate
      });

      Object.keys(map).forEach(function(channelKey) {
        rows.push([
          startDate,
          endDate,
          channelKey,
          site.product,
          site.groupName,
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          map[channelKey]
        ]);
      });

      Logger.log("GA 站點完成：" + site.groupName + " / " + Object.keys(map).length + " 筆");
    } catch (e) {
      Logger.log("GA 站點失敗：" + site.groupName + " / " + (e.stack || e.message));
    }
  });

  return rows;
}

function fetchSiteAdClickGaEventCountMap_(opt) {
  return fetchGaMap_({
    propertyId: opt.propertyId,
    dimensions: ["firstUserMedium"],
    metrics: ["eventCount"],
    startDate: opt.startDate,
    endDate: opt.endDate,
    dimensionFilter: {
      andGroup: {
        expressions: [
          {
            filter: {
              fieldName: "firstUserSource",
              stringFilter: {
                matchType: "EXACT",
                value: "dh",
                caseSensitive: false
              }
            }
          },
          {
            filter: {
              fieldName: "eventName",
              stringFilter: {
                matchType: "CONTAINS",
                value: "广告点击",
                caseSensitive: false
              }
            }
          }
        ]
      }
    }
  });
}


/****************************************************
 * GA 通用查詢
 ****************************************************/

function fetchGaMap_(opt) {
  var request = {
    dateRanges: [
      {
        startDate: opt.startDate,
        endDate: opt.endDate
      }
    ],
    dimensions: opt.dimensions.map(function(name) {
      return { name: name };
    }),
    metrics: opt.metrics.map(function(name) {
      return { name: name };
    }),
    limit: CONFIG.GA_LIMIT
  };

  if (opt.dimensionFilter) {
    request.dimensionFilter = opt.dimensionFilter;
  }

  var response = AnalyticsData.Properties.runReport(
    request,
    "properties/" + opt.propertyId
  );

  var result = {};

  if (!response.rows) return result;

  response.rows.forEach(function(row) {
    var rawChannel = row.dimensionValues[0].value || "";
    var channelKey = normalizeChannelCode_(rawChannel);

    if (!channelKey || channelKey === "(not set)") return;

    var value = toNumberOrZero_(row.metricValues[0].value);
    result[channelKey] = (result[channelKey] || 0) + value;
  });

  return result;
}


/****************************************************
 * Sheet 寫入
 ****************************************************/

function writeOutputByReplacingRanges_(ranges, newRows) {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet) sheet = ss.insertSheet(CONFIG.SHEET_NAME);

  ensureHeaders_(sheet);

  clearSheetBody_(sheet);

  if (newRows.length > 0) {
    sheet
      .getRange(2, 1, newRows.length, CONFIG.HEADERS.length)
      .setValues(newRows);
  }

  sheet.setFrozenRows(1);

  Logger.log(
    "已清除所有舊資料，只保留最近 " +
    CONFIG.WEEK_RANGE_COUNT +
    " 個完整週：" +
    ranges.map(function(r) {
      return r.start + " ~ " + r.end;
    }).join("；") +
    " / 共 " +
    newRows.length +
    " 筆"
  );
}

function ensureHeaders_(sheet) {
  sheet
    .getRange(1, 1, 1, CONFIG.HEADERS.length)
    .setValues([CONFIG.HEADERS])
    .setFontWeight("bold");
}

function readExistingRows_(sheet) {
  var lastRow = sheet.getLastRow();

  if (lastRow <= 1) return [];

  var values = sheet
    .getRange(2, 1, lastRow - 1, CONFIG.HEADERS.length)
    .getValues();

  return values.filter(function(row) {
    return row.some(function(cell) {
      return cell !== "";
    });
  });
}

function clearSheetBody_(sheet) {
  var lastRow = sheet.getLastRow();

  if (lastRow > 1) {
    sheet
      .getRange(2, 1, lastRow - 1, CONFIG.HEADERS.length)
      .clearContent();
  }
}


/****************************************************
 * 日期工具
 ****************************************************/

function getWeeklyRanges_() {
  var today = new Date();
  today.setHours(0, 0, 0, 0);

  var day = today.getDay();

  var thisWeekSunday = new Date(today);
  thisWeekSunday.setDate(today.getDate() - day);

  var ranges = [];

  for (var i = CONFIG.WEEK_RANGE_COUNT - 1; i >= 0; i--) {
    var start = new Date(thisWeekSunday);
    start.setDate(thisWeekSunday.getDate() - 7 * (i + 1));

    var end = new Date(start);
    end.setDate(start.getDate() + 6);

    ranges.push({
      start: formatDate_(start),
      end: formatDate_(end)
    });
  }

  return ranges;
}

function splitDateRange_(start, end, batchDays) {
  var s = new Date(start + "T00:00:00");
  var e = new Date(end + "T00:00:00");
  var out = [];
  var cur = new Date(s);

  while (cur <= e) {
    var next = new Date(cur);
    next.setDate(cur.getDate() + batchDays - 1);

    if (next > e) next = new Date(e);

    out.push({
      start: formatDate_(cur),
      end: formatDate_(next)
    });

    cur = new Date(next);
    cur.setDate(cur.getDate() + 1);
  }

  return out;
}

function formatDate_(date) {
  return Utilities.formatDate(date, "Asia/Taipei", "yyyy-MM-dd");
}

function normalizeDateValue_(value) {
  if (value === null || value === undefined || value === "") return "";

  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime())) {
    return formatDate_(value);
  }

  var s = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  var d = new Date(s);

  if (!isNaN(d.getTime())) return formatDate_(d);

  return s;
}


/****************************************************
 * 渠道模糊匹配
 ****************************************************/

function normalizeChannelCode_(value) {
  var s = String(value || "").trim().toLowerCase();

  if (!s) return "";

  s = s.replace(/^dh/i, "");

  if (/\d[a-z]$/i.test(s)) {
    s = s.replace(/[a-z]$/i, "");
  }

  return s;
}


/****************************************************
 * 工具
 ****************************************************/

function toNumberOrZero_(v) {
  if (v === "" || v === null || v === undefined) return 0;

  var n = Number(v);

  return isNaN(n) ? 0 : n;
}

function compareOutputRows_(a, b) {
  var aStart = normalizeDateValue_(a[0]);
  var bStart = normalizeDateValue_(b[0]);

  if (aStart !== bStart) return aStart < bStart ? -1 : 1;

  var aProduct = String(a[3] || "");
  var bProduct = String(b[3] || "");

  if (aProduct !== bProduct) return aProduct < bProduct ? -1 : 1;

  var aChannel = String(a[2] || "");
  var bChannel = String(b[2] || "");

  if (aChannel !== bChannel) return aChannel < bChannel ? -1 : 1;

  var aGroup = String(a[4] || "");
  var bGroup = String(b[4] || "");

  if (aGroup !== bGroup) return aGroup < bGroup ? -1 : 1;

  return 0;
}

function deleteTriggerByFunctionName_(functionName) {
  var triggers = ScriptApp.getProjectTriggers();

  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === functionName) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function listProjectTriggers_成效輸入() {
  var triggers = ScriptApp.getProjectTriggers();

  triggers.forEach(function(t, i) {
    Logger.log(
      (i + 1) +
      ". function=" +
      t.getHandlerFunction() +
      ", type=" +
      t.getEventType()
    );
  });
}