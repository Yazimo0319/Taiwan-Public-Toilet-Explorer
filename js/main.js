// 主流程：loadData → switchCounty → 資訊卡片 → 兩張圖表 → loadMapData。
// 預設新北市，沿用同一張地圖與兩個圖表實例切換 22 縣市。
var countyCode = "65000";
var barChart;
var donutChart;
var toiletMap;
var statsData;
var mapRequestId = 0; // 每次選擇加 1，舊請求即使較晚回來也不採用。
var pendingMapData = null; // 底圖未完成前，暫存最後一次選擇的地圖資料。
var mapDataReady = false; // 點位還在更新時，不允許點擊上一個縣市的資料。
var currentPopup;

// 1. 讀取已整理好的 JSON，不重新計算原始 CSV。
function loadData() {
    fetch("./data/processed/stats.json")
        .then(function (response) {
            if (!response.ok) {
                throw new Error("統計資料讀取失敗");
            }
            return response.json();
        })
        .then(function (data) {
            statsData = data;
            setupCountySelect();
            switchCounty(countyCode);
        })
        .catch(function (error) {
            showError(error.message);
        });
}

// 使用 stats.json 內的官方縣市名稱與五碼代碼建立選項。
function setupCountySelect() {
    var select = document.getElementById("countySelect");
    select.textContent = "";
    var codes = Object.keys(statsData.counties);
    for (var index = 0; index < codes.length; index++) {
        var code = codes[index];
        var option = document.createElement("option");
        option.value = code;
        option.textContent = statsData.counties[code].county_name;
        select.appendChild(option);
    }
    select.value = countyCode;
    select.disabled = false;
    select.addEventListener("change", function () {
        switchCounty(select.value);
    });
}

// 切換的共同入口：更新統計，並開始讀取該縣市的地圖資料。
function switchCounty(selectedCode) {
    var countyData = statsData.counties[selectedCode];
    if (!countyData) {
        showError("找不到縣市資料");
        return;
    }
    countyCode = selectedCode;
    mapRequestId = mapRequestId + 1;
    pendingMapData = null;
    mapDataReady = false;
    if (currentPopup) {
        currentPopup.remove();
        currentPopup = null;
    }
    if (toiletMap && toiletMap.getSource("toilets")) {
        // 載入期間先清空舊縣市點位，避免誤認為新縣市的資料。
        toiletMap.getSource("toilets").setData({ type: "FeatureCollection", features: [] });
    }
    document.getElementById("mapTitle").textContent = countyData.county_name + "公廁地圖";
    showMapMessage("正在讀取" + countyData.county_name + "地圖資料…", false);

    try {
        var typeList = Object.keys(statsData.national.type_counts);
        var barData = prepareChartData(countyData.type_counts, typeList, countyData.record_count);
        var placeList = Object.keys(countyData.type2_counts);
        var donutData = prepareChartData(countyData.type2_counts, placeList, countyData.record_count);
        updateInfoCards(countyData);
        updateInsights(countyData, barData, donutData);
        if (typeof echarts === "undefined") {
            throw new Error("圖表載入失敗，請檢查網路");
        }
        createBarChart(countyData, barData);
        createDonutChart(countyData, donutData);
        document.getElementById("rightUpChart").setAttribute("aria-label", countyData.county_name + "公廁類型水平長條圖");
        document.getElementById("rightDownChart").setAttribute("aria-label", countyData.county_name + "場所類別圓環圖");
        document.getElementById("loadStatus").hidden = true;
    } catch (error) {
        showError(error.message);
    }
    loadMapData(countyData, mapRequestId);
}

// 2. 用 for 整理分類與合計，再排序成圖表資料；空白與未設定保留。
function prepareChartData(counts, categoryList, expectedTotal) {
    var chartData = [];
    var total = 0;
    for (var index = 0; index < categoryList.length; index++) {
        var category = categoryList[index];
        var count = 0;
        if (counts[category] !== undefined) {
            count = counts[category];
        }
        var displayName = category;
        if (category === "") {
            displayName = "缺漏（空白）";
        }
        chartData.push({ name: displayName, value: count });
        total = total + count;
    }
    if (total !== expectedTotal) {
        throw new Error("圖表資料筆數不符");
    }
    chartData.sort(function (a, b) {
        return b.value - a.value;
    });
    return chartData;
}

// 資訊卡片：顯示目前選取縣市的公廁資料筆數。
function updateInfoCards(countyData) {
    document.getElementById("recordCount").textContent =
        countyData.record_count.toLocaleString("zh-TW") + " 筆";
}

// 從目前縣市的排序結果，顯示各分類第一名；並列時一起列出。
function updateInsights(countyData, typeData, placeData) {
    function describeTop(data) {
        if (data.length === 0 || countyData.record_count === 0) { return "沒有資料"; }
        var names = [];
        var count = data[0].value;
        for (var index = 0; index < data.length; index++) {
            if (data[index].value === count) { names.push(data[index].name); }
        }
        var each = names.length > 1 ? "各 " : "";
        return names.join("、") + "（" + each + count.toLocaleString("zh-TW") +
            " 筆，占 " + (count / countyData.record_count * 100).toFixed(1) + "%）";
    }
    document.getElementById("insightText").textContent = countyData.county_name +
        "：公廁類型以 " + describeTop(typeData) + " 最多；場所類別以 " +
        describeTop(placeData) + " 最多。";
}

// 公廁類型水平長條圖。
function createBarChart(countyData, chartData) {
    var typeNames = [];
    var typeCounts = [];
    for (var index = 0; index < chartData.length; index++) {
        typeNames.push(chartData[index].name);
        typeCounts.push(chartData[index].value);
    }

    if (!barChart) {
        document.getElementById("rightUpChart").textContent = "";
        barChart = echarts.init(document.getElementById("rightUpChart"));
    }
    barChart.dispatchAction({ type: "hideTip" });
    var option = {
        animation: false,
        title: {
            text: countyData.county_name + "公廁類型", // 可修改長條圖標題。
            left: 16,
            top: 14,
            textStyle: { fontSize: 18, color: "#236b70" }
        },
        tooltip: { show: false },
        grid: { left: 110, right: 55, top: 56, bottom: 48 },
        xAxis: {
            type: "value",
            name: "建檔紀錄數（筆）",
            nameLocation: "middle",
            nameGap: 30,
            minInterval: 1,
            axisLabel: { fontSize: 11, hideOverlap: true }
        },
        yAxis: {
            type: "category",
            inverse: true, // 排序後第一名顯示在最上方。
            data: typeNames,
            axisTick: { show: false },
            axisLabel: { interval: 0, fontSize: 12 }
        },
        series: [{
            name: "建檔紀錄數",
            type: "bar",
            data: typeCounts,
            barMaxWidth: 22,
            itemStyle: { color: "#16858a" }, // 可修改長條顏色。
            label: {
                show: true,
                position: "right",
                formatter: function (params) {
                    return params.value.toLocaleString("zh-TW");
                }
            }
        }]
    };
    barChart.setOption(option, true); // 更新原實例，完整替換舊縣市設定。
}

// 場所類別圓環圖：保留全部原始分類，圖例可翻頁。
function createDonutChart(countyData, chartData) {
    if (!donutChart) {
        document.getElementById("rightDownChart").textContent = "";
        donutChart = echarts.init(document.getElementById("rightDownChart"));
    }
    donutChart.dispatchAction({ type: "hideTip" });
    var option = {
        animation: false,
        color: ["#16858a", "#4a9cba", "#67afa2", "#7188b5", "#b7a36a",
                "#9c7caa", "#b77c72", "#7c9672", "#7d8a91", "#b3a796"], // 圓環配色。
        title: {
            text: countyData.county_name + "場所類別", // 可修改圓環圖標題。
            left: 16,
            top: 14,
            textStyle: { fontSize: 18, color: "#236b70" }
        },
        tooltip: {
            trigger: "item",
            renderMode: "richText",
            confine: true,
            formatter: function (params) {
                var percent = 0;
                if (countyData.record_count > 0) {
                    percent = params.value / countyData.record_count * 100;
                }
                return params.name + "\n建檔紀錄數：" +
                    params.value.toLocaleString("zh-TW") + " 筆\n比例：" +
                    percent.toFixed(2) + "%";
            }
        },
        legend: {
            type: "scroll",
            orient: "vertical",
            left: "48%",
            right: 12,
            top: 58,
            bottom: 14,
            itemWidth: 10,
            itemHeight: 10,
            itemGap: 12,
            selectedMode: false, // 固定呈現完整分母，不因點選圖例隱藏類別。
            textStyle: { fontSize: 12, lineHeight: 18 },
            formatter: function (name) {
                for (var index = 0; index < chartData.length; index++) {
                    if (chartData[index].name === name) {
                        var count = chartData[index].value;
                        var percent = 0;
                        if (countyData.record_count > 0) {
                            percent = count / countyData.record_count * 100;
                        }
                        return name + "\n" + count.toLocaleString("zh-TW") +
                            " 筆（" + percent.toFixed(2) + "%）";
                    }
                }
                return name;
            }
        },
        series: [{
            name: "場所類別",
            type: "pie",
            radius: ["24%", "44%"], // 內、外半徑不同，所以會呈現圓環。
            center: ["24%", "56%"],
            data: chartData,
            label: { show: false },
            labelLine: { show: false },
            emphasis: { scale: false }
        }]
    };
    donutChart.setOption(option, true); // 新圖例與資料取代舊縣市，不建立新實例。
}

// JSON 或圖表程式庫載入失敗時，畫面顯示基本提示。
function showError(message) {
    if (barChart) {
        barChart.dispose();
        barChart = null;
    }
    if (donutChart) {
        donutChart.dispose();
        donutChart = null;
    }
    var status = document.getElementById("loadStatus");
    status.hidden = false;
    status.setAttribute("role", "alert");
    status.textContent = message + "，請重新整理。";
    document.getElementById("rightUpChart").textContent = "長條圖尚未載入";
    document.getElementById("rightDownChart").textContent = "圓環圖尚未載入";
}

// 視窗大小改變時，讓圖表符合既有的 60% / 40% 排版。
window.addEventListener("resize", function () {
    if (barChart) {
        barChart.resize();
    }
    if (donutChart) {
        donutChart.resize();
    }
    if (toiletMap) {
        toiletMap.resize();
    }
});

// 各縣市路徑來自 stats.json，請求編號保護快速連續切換。
function loadMapData(countyData, requestId) {
    fetch("./" + countyData.geojson_path)
        .then(function (response) {
            if (!response.ok) {
                throw new Error("地圖資料讀取失敗");
            }
            return response.json();
        })
        .then(function (geojson) {
            if (requestId !== mapRequestId) { return; }
            if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
                throw new Error("地圖資料格式錯誤");
            }
            if (geojson.features.length !== countyData.map_record_count) {
                throw new Error("地圖資料筆數不符");
            }
            pendingMapData = { geojson: geojson, countyData: countyData,
                               requestId: requestId };
            if (geojson.features.length === 0 && !toiletMap) {
                showMapMessage(countyData.county_name + "沒有公廁位置資料。", false);
                return;
            }
            if (typeof maplibregl === "undefined") {
                throw new Error("地圖載入失敗，請檢查網路");
            }
            if (!toiletMap) {
                createMap(geojson); // 整個網頁只建立一次 MapLibre 地圖。
            } else if (toiletMap && toiletMap.getSource("toilets")) {
                updateMapData(pendingMapData);
            }
            // 底圖還沒載入時先保留最新 pendingMapData，由 load 事件接續處理。
        })
        .catch(function (error) {
            if (requestId !== mapRequestId) { return; }
            pendingMapData = null;
            showMapMessage(countyData.county_name + "：" + error.message, true);
        });
}

// 取得視角範圍；保留離島與所有地圖資料，不用臺灣本島的固定範圍。
function getMapBounds(geojson) {
    if (geojson.features.length === 0) { return null; }
    var longitudes = [];
    var latitudes = [];
    for (var index = 0; index < geojson.features.length; index++) {
        var coordinates = geojson.features[index].geometry.coordinates;
        longitudes.push(coordinates[0]);
        latitudes.push(coordinates[1]);
    }
    longitudes.sort(function (a, b) { return a - b; });
    latitudes.sort(function (a, b) { return a - b; });
    var first = 0;
    var last = longitudes.length - 1;
    // 跨度超過 2 度時用中央 98% 決定「初始視角」，避免少量遠端座標拉遠畫面。
    // 這只是視角規則，不判定位置真偽，也不移除任何紀錄或修正其座標。
    if (longitudes[last] - longitudes[0] > 2 || latitudes[last] - latitudes[0] > 2) {
        first = Math.floor(longitudes.length * 0.01);
        last = Math.ceil(longitudes.length * 0.99) - 1;
    }
    return new maplibregl.LngLatBounds(
        [longitudes[first], latitudes[first]], [longitudes[last], latitudes[last]]);
}

// 更新同一個 Source 並調整視角，不重建地圖或重新註冊圖層與事件。
function updateMapData(current) {
    if (current.requestId !== mapRequestId) { return; }
    mapDataReady = false;
    toiletMap.getSource("toilets").setData(current.geojson);
    var bounds = getMapBounds(current.geojson);
    if (bounds) {
        toiletMap.fitBounds(bounds, {
            padding: { top: 70, bottom: 40, left: 40, right: 40 },
            maxZoom: 13, duration: 0
        });
    }
    showMapMessage("正在更新" + current.countyData.county_name + "地圖點位…", false);
}

function showMapSummary(countyData) {
    // 正常成功不顯示重複筆數，只保留異常或無點位的必要提示。
    var message = "";
    if (countyData.excluded_coordinate_count > 0) {
        message = countyData.county_name + "：" + countyData.excluded_coordinate_count +
            " 筆位置資料未顯示。";
    }
    if (countyData.map_record_count === 0) {
        message += "沒有公廁位置資料。";
    }
    showMapMessage(message, false);
}

// 建立 MapLibre 地圖。只有一個 GeoJSON Source，不逐筆建立 HTML Marker。
function createMap(geojson) {
    var container = document.getElementById("mainChart");
    var mapTitle = document.getElementById("mapTitle");
    container.textContent = "";
    toiletMap = new maplibregl.Map({
        container: "mainChart",
        style: "https://tiles.openfreemap.org/styles/liberty",
        bounds: getMapBounds(geojson),
        fitBoundsOptions: { padding: { top: 70, bottom: 40, left: 40, right: 40 }, duration: 0 },
        maxZoom: 18,
        dragRotate: false,
        pitchWithRotate: false
    });
    container.appendChild(mapTitle);
    toiletMap.touchZoomRotate.disableRotation();
    toiletMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    showMapMessage("地圖載入中…", false);

    // 先監聽地圖錯誤，Token 或底圖失敗時不移除 ECharts 圖表。
    toiletMap.on("error", function () {
        showMapMessage("地圖載入失敗，請重新整理。", true);
    });
    toiletMap.on("load", function () {
        addToiletLayers({ type: "FeatureCollection", features: [] });
        // 圖層建立後，直接在這裡註冊點擊與游標事件。
        toiletMap.on("click", "toilet-clusters", expandCluster);
        toiletMap.on("click", "toilet-points", showToiletPopup);
        var layers = ["toilet-clusters", "toilet-points"];
        for (var index = 0; index < layers.length; index++) {
            toiletMap.on("mouseenter", layers[index], function () {
                toiletMap.getCanvas().style.cursor = "pointer";
            });
            toiletMap.on("mouseleave", layers[index], function () {
                toiletMap.getCanvas().style.cursor = "";
            });
        }
        if (pendingMapData) { updateMapData(pendingMapData); }
    });
    toiletMap.on("sourcedata", function (event) {
        if (event.sourceId === "toilets" && toiletMap.isSourceLoaded("toilets") &&
            pendingMapData && pendingMapData.requestId === mapRequestId) {
            mapDataReady = true;
            showMapSummary(pendingMapData.countyData);
        }
    });
}

// Source 保存資料，三個 Layer 分別畫群聚、群聚筆數及個別點位。
function addToiletLayers(geojson) {
    toiletMap.addSource("toilets", {
        type: "geojson",
        data: geojson,
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 50
    });
    toiletMap.addLayer({
        id: "toilet-clusters",
        type: "circle",
        source: "toilets",
        filter: ["has", "point_count"],
        paint: {
            "circle-color": "#16858a", // 群聚圓圈的顏色。
            "circle-radius": 22, // 群聚圓圈的大小（像素）。
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff"
        }
    });
    toiletMap.addLayer({
        id: "toilet-cluster-count",
        type: "symbol",
        source: "toilets",
        filter: ["has", "point_count"],
        layout: {
            "text-field": ["get", "point_count"], // 完整建檔紀錄數，不用縮寫。
            "text-font": ["Noto Sans Regular"],
            "text-size": 13
        },
        paint: { "text-color": "#ffffff" }
    });
    toiletMap.addLayer({
        id: "toilet-points",
        type: "circle",
        source: "toilets",
        filter: ["!", ["has", "point_count"]],
        paint: {
            "circle-color": "#277ba2", // 個別公廁點位的顏色。
            "circle-radius": 6, // 個別點位的大小（像素）。
            "circle-stroke-width": 1,
            "circle-stroke-color": "#ffffff"
        }
    });
}

// MapLibre 計算群聚展開所需層級，再直接放大，不加入飛行動畫。
function expandCluster(event) {
    if (!mapDataReady || !event.features || event.features.length === 0) { return; }
    var requestId = mapRequestId;
    var feature = event.features[0];
    var clusterId = feature.properties.cluster_id;
    toiletMap.getSource("toilets").getClusterExpansionZoom(clusterId)
        .then(function (zoom) {
            if (requestId !== mapRequestId) { return; }
            toiletMap.jumpTo({ center: feature.geometry.coordinates, zoom: zoom });
        })
        .catch(function () {
            if (requestId !== mapRequestId) { return; }
            showMapMessage("群聚暫時無法展開，請稍後再點擊。", true);
        });
}

// Popup 全部來自被點擊的 GeoJSON properties；文字不當成 HTML 執行。
function showToiletPopup(event) {
    if (!mapDataReady || !event.features || event.features.length === 0) { return; }
    if (currentPopup) { currentPopup.remove(); }
    var feature = event.features[0];
    var properties = feature.properties;
    var content = document.createElement("div");
    content.className = "toiletPopup";
    var title = document.createElement("h3");
    title.textContent = popupValue(properties.name);
    content.appendChild(title);
    var fields = ["address", "type", "type2"];
    var labels = ["地址", "公廁類型", "場所類別"];
    for (var index = 0; index < fields.length; index++) {
        var line = document.createElement("p");
        line.textContent = labels[index] + "：" + popupValue(properties[fields[index]]);
        content.appendChild(line);
    }
    currentPopup = new maplibregl.Popup({ maxWidth: "300px" })
        .setLngLat(feature.geometry.coordinates)
        .setDOMContent(content)
        .addTo(toiletMap);
}

function popupValue(value) {
    if (value === "" || value === null || value === undefined) { return "缺漏（空白）"; }
    return value;
}

// 地圖使用獨立提示，不影響圖表的 loadStatus 與錯誤處理。
function showMapMessage(message, isError) {
    var status = document.getElementById("mapStatus");
    status.textContent = message;
    status.hidden = message === ""; // 隱藏時不占版面；載入或錯誤訊息會重新顯示。
    if (isError) {
        status.setAttribute("role", "alert");
    } else {
        status.setAttribute("role", "status");
    }
}

loadData();
