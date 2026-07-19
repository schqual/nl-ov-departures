// NL OV Departures — PebbleKit JS companion
//
// Responsibilities:
//   1. Store the user's favourite stops (localStorage) — set via the
//      config screen.
//   2. On each refresh (REQUEST_REFRESH from watch, or our own timer):
//      - get phone GPS
//      - pick the nearest 1-3 favourites
//      - fetch live departures for those stops from OVapi.nl
//      - merge, sort by ETA, take the soonest 5
//      - send them to the watch via AppMessage
//   3. Serve the config screen (favourites editor + "use GPS" button)
//      via a data: URI, so no external hosting is required.
//
// OVapi.nl reference: https://github.com/skywave/OVAPI/wiki
// Endpoint used: https://v0.ovapi.nl/tpc/{TimingPointCode}
// (Free, no API key. Covers bus/tram/metro/train nationwide, unlike
// NS's Reisinformatie API which is train-only — see project README
// for why OVapi was chosen instead.)

var STORAGE_KEY = 'nlOvDeparturesFavourites';
var MAX_FAVOURITES_TO_QUERY = 3;
var MAX_DEPARTURES_TO_SEND = 5;
var OVAPI_BASE = 'https://v0.ovapi.nl/tpc/';

// ---------------------------------------------------------------------
// Favourites storage
// ---------------------------------------------------------------------

function loadFavourites() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed.stops) ? parsed.stops : [];
  } catch (e) {
    console.log('loadFavourites: failed to parse stored favourites: ' + e);
    return [];
  }
}

function saveFavourites(stops) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ stops: stops }));
}

// ---------------------------------------------------------------------
// Distance helper (Haversine, good enough for "which stop is nearest")
// ---------------------------------------------------------------------

function haversineMeters(lat1, lon1, lat2, lon2) {
  var R = 6371000;
  var toRad = function (d) { return (d * Math.PI) / 180; };
  var dLat = toRad(lat2 - lat1);
  var dLon = toRad(lon2 - lon1);
  var a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// NOTE (todo, see README): with several favourites at similar
// distances, this picks a strict nearest-N every refresh, which could
// flip the selection between two stops as the phone's GPS fix jitters.
// If that's annoying in practice, add hysteresis here, e.g. only swap
// out a previously-selected stop if a candidate is closer by some
// margin (say 75m) rather than by any amount.
function pickNearestFavourites(favourites, lat, lon, n) {
  var withDistance = favourites.map(function (stop) {
    return {
      stop: stop,
      distance: haversineMeters(lat, lon, parseFloat(stop.lat), parseFloat(stop.lon))
    };
  });
  withDistance.sort(function (a, b) { return a.distance - b.distance; });
  return withDistance.slice(0, n).map(function (x) { return x.stop; });
}

// ---------------------------------------------------------------------
// OVapi fetch + merge
// ---------------------------------------------------------------------

// Fetches all TPCs for one favourite stop entry (a stop can have
// several comma-separated TPCs, e.g. both directions of a bus stop)
// and returns a flat array of departure objects.
function fetchDeparturesForStop(stop, callback) {
  var tpcs = (stop.tpc || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var results = [];
  var remaining = tpcs.length;

  if (remaining === 0) {
    callback([]);
    return;
  }

  tpcs.forEach(function (tpc) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', OVAPI_BASE + encodeURIComponent(tpc), true);
    xhr.timeout = 8000;
    xhr.onload = function () {
      remaining--;
      try {
        if (xhr.status === 200) {
          var data = JSON.parse(xhr.responseText);
          results = results.concat(parseOvapiResponse(data));
        }
      } catch (e) {
        console.log('fetchDeparturesForStop: parse error for ' + tpc + ': ' + e);
      }
      if (remaining === 0) callback(results);
    };
    xhr.onerror = xhr.ontimeout = function () {
      remaining--;
      console.log('fetchDeparturesForStop: request failed for ' + tpc);
      if (remaining === 0) callback(results);
    };
    xhr.send();
  });
}

// OVapi's /tpc/{code} response is nested: { [tpc]: { [transportType]: { [journeyId]: {...} } } }
// Each journey has ExpectedArrivalTime / TargetArrivalTime, Destination info, LinePublicNumber.
function parseOvapiResponse(data) {
  var departures = [];
  var now = Date.now();

  Object.keys(data).forEach(function (tpc) {
    var byType = data[tpc];
    Object.keys(byType).forEach(function (transportType) {
      var journeys = byType[transportType];
      Object.keys(journeys).forEach(function (journeyId) {
        var j = journeys[journeyId];
        var etaString = j.ExpectedArrivalTime || j.TargetArrivalTime;
        if (!etaString) return;

        var etaMs = new Date(etaString).getTime();
        if (isNaN(etaMs)) return;

        var minutes = Math.round((etaMs - now) / 60000);
        if (minutes < 0) minutes = 0;

        departures.push({
          line: j.LinePublicNumber || '?',
          direction: j.DestinationName50 || j.DestinationName || '',
          etaMs: etaMs,
          minutes: minutes
        });
      });
    });
  });

  return departures;
}

function mergeAndSortDepartures(allDepartures) {
  allDepartures.sort(function (a, b) { return a.etaMs - b.etaMs; });
  return allDepartures.slice(0, MAX_DEPARTURES_TO_SEND);
}

// ---------------------------------------------------------------------
// AppMessage send
// ---------------------------------------------------------------------

function sendDeparturesToWatch(departures) {
  var payload = { 'COUNT': departures.length };

  departures.forEach(function (d, i) {
    payload['LINE_' + i] = String(d.line).substring(0, 15);
    payload['DIR_' + i] = String(d.direction).substring(0, 47);
    payload['MIN_' + i] = String(d.minutes);
  });

  Pebble.sendAppMessage(payload, function () {
    // sent ok
  }, function (e) {
    console.log('sendDeparturesToWatch: send failed: ' + JSON.stringify(e));
  });
}

function sendErrorToWatch(message) {
  Pebble.sendAppMessage({ 'ERROR': message }, function () {}, function (e) {
    console.log('sendErrorToWatch: send failed: ' + JSON.stringify(e));
  });
}

// ---------------------------------------------------------------------
// Main refresh flow
// ---------------------------------------------------------------------

function refresh() {
  var favourites = loadFavourites();

  if (favourites.length === 0) {
    sendErrorToWatch('No favourite stops set. Use the app settings to add some.');
    return;
  }

  if (!navigator.geolocation) {
    sendErrorToWatch('No GPS available on phone.');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    function (pos) {
      var lat = pos.coords.latitude;
      var lon = pos.coords.longitude;
      var nearest = pickNearestFavourites(favourites, lat, lon, MAX_FAVOURITES_TO_QUERY);

      var allDepartures = [];
      var remaining = nearest.length;

      nearest.forEach(function (stop) {
        fetchDeparturesForStop(stop, function (departures) {
          remaining--;
          allDepartures = allDepartures.concat(departures);
          if (remaining === 0) {
            var merged = mergeAndSortDepartures(allDepartures);
            if (merged.length === 0) {
              sendErrorToWatch('No departures found nearby.');
            } else {
              sendDeparturesToWatch(merged);
            }
          }
        });
      });
    },
    function (err) {
      sendErrorToWatch('GPS error: ' + err.message);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

// ---------------------------------------------------------------------
// Config screen (embedded template, opened as a data: URI)
// ---------------------------------------------------------------------
//
// This mirrors config/config.html — if you edit the UI there for
// development/readability, copy the change into this string too.
// Keeping it inline avoids needing to host the config page externally,
// which Pebble's showConfiguration flow would otherwise require.

var CONFIG_HTML = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>NL OV Departures</title><style>' +
  'body{font-family:-apple-system,sans-serif;margin:0;padding:16px;background:#f4f4f4}' +
  'h1{font-size:18px}.stop{background:#fff;border-radius:8px;padding:12px;margin-bottom:12px}' +
  '.stop label{display:block;font-size:12px;color:#666;margin-top:8px}' +
  '.stop input{width:100%;box-sizing:border-box;padding:6px;font-size:14px}' +
  '.row{display:flex;gap:8px}.row input{flex:1}' +
  'button{padding:10px 16px;font-size:14px;border-radius:6px;border:none;margin-top:8px}' +
  '.btn-primary{background:#0060ff;color:#fff;width:100%}.btn-secondary{background:#ddd}' +
  '.btn-danger{background:#ffe0e0;color:#a00}#add-stop-btn{width:100%}' +
  '</style></head><body>' +
  '<h1>Favourite stops</h1>' +
  '<p>Add the stops you want NL OV Departures to consider. On each refresh the watch app ' +
  'picks the 1-3 nearest to your phone and shows the soonest 5 departures across them.</p>' +
  '<div id="stops"></div>' +
  '<button id="add-stop-btn" class="btn-secondary">+ Add stop</button>' +
  '<button id="save-btn" class="btn-primary">Save</button>' +
  '<script>' +
  'var stops = INITIAL_STOPS_PLACEHOLDER;' +
  'function render(){' +
  'var c=document.getElementById("stops");c.innerHTML="";' +
  'stops.forEach(function(stop,i){' +
  'var div=document.createElement("div");div.className="stop";' +
  'div.innerHTML="<label>Name</label><input data-i=\\""+i+"\\" data-field=\\"name\\" value=\\""+(stop.name||"")+"\\">"+' +
  '"<label>OVapi TimingPointCode(s), comma-separated</label><input data-i=\\""+i+"\\" data-field=\\"tpc\\" value=\\""+(stop.tpc||"")+"\\">"+' +
  '"<div class=\\"row\\"><div style=\\"flex:1\\"><label>Latitude</label><input data-i=\\""+i+"\\" data-field=\\"lat\\" value=\\""+(stop.lat!=null?stop.lat:"")+"\\"></div>"+' +
  '"<div style=\\"flex:1\\"><label>Longitude</label><input data-i=\\""+i+"\\" data-field=\\"lon\\" value=\\""+(stop.lon!=null?stop.lon:"")+"\\"></div></div>"+' +
  '"<button class=\\"btn-secondary use-gps-btn\\" data-i=\\""+i+"\\">Use current GPS location</button> "+' +
  '"<button class=\\"btn-danger remove-btn\\" data-i=\\""+i+"\\">Remove</button>";' +
  'c.appendChild(div);});' +
  'c.querySelectorAll("input").forEach(function(inp){inp.addEventListener("input",function(){' +
  'var i=parseInt(inp.getAttribute("data-i"),10);var f=inp.getAttribute("data-field");stops[i][f]=inp.value;});});' +
  'c.querySelectorAll(".remove-btn").forEach(function(btn){btn.addEventListener("click",function(){' +
  'var i=parseInt(btn.getAttribute("data-i"),10);stops.splice(i,1);render();});});' +
  'c.querySelectorAll(".use-gps-btn").forEach(function(btn){btn.addEventListener("click",function(){' +
  'var i=parseInt(btn.getAttribute("data-i"),10);btn.textContent="Locating...";' +
  'if(!navigator.geolocation){alert("Geolocation not available. Enter lat/lon manually.");btn.textContent="Use current GPS location";return;}' +
  'navigator.geolocation.getCurrentPosition(function(pos){stops[i].lat=pos.coords.latitude;stops[i].lon=pos.coords.longitude;render();},' +
  'function(err){alert("Could not get location ("+err.message+"). Enter lat/lon manually.");btn.textContent="Use current GPS location";},' +
  '{enableHighAccuracy:true,timeout:10000});});});}' +
  'document.getElementById("add-stop-btn").addEventListener("click",function(){stops.push({name:"",tpc:"",lat:"",lon:""});render();});' +
  'document.getElementById("save-btn").addEventListener("click",function(){' +
  'var cleaned=stops.filter(function(s){return s.name&&s.tpc&&s.lat!==""&&s.lon!=="";}).map(function(s){' +
  'return{name:s.name,tpc:s.tpc,lat:parseFloat(s.lat),lon:parseFloat(s.lon)};});' +
  'var payload={stops:cleaned};' +
  'document.location="pebblejs://close#"+encodeURIComponent(JSON.stringify(payload));});' +
  'render();' +
  '<' + '/script></body></html>';

function buildConfigUrl() {
  var favourites = loadFavourites();
  var html = CONFIG_HTML.replace(
    'INITIAL_STOPS_PLACEHOLDER',
    JSON.stringify(favourites).replace(/</g, '\\u003c')
  );
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

// ---------------------------------------------------------------------
// Pebble event wiring
// ---------------------------------------------------------------------

Pebble.addEventListener('ready', function () {
  console.log('NL OV Departures companion ready');
  refresh();
});

Pebble.addEventListener('appmessage', function (e) {
  if (e.payload && e.payload['REQUEST_REFRESH'] !== undefined) {
    refresh();
  }
});

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(buildConfigUrl());
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e.response) return; // user cancelled
  try {
    var decoded = JSON.parse(decodeURIComponent(e.response));
    if (decoded && Array.isArray(decoded.stops)) {
      saveFavourites(decoded.stops);
      refresh();
    }
  } catch (ex) {
    console.log('webviewclosed: failed to parse config response: ' + ex);
  }
});
