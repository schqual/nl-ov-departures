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
var OVAPI_BASE = 'http://v0.ovapi.nl/tpc/';

// ---------------------------------------------------------------------
// Favourites storage
// ---------------------------------------------------------------------

var DEFAULT_FAVOURITES = [
   { name: 'Liesveldviaduct', tpc: '31002471', lat: 0, lon: 0 }
];

function loadFavourites() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_FAVOURITES;
    var parsed = JSON.parse(raw);
    var stops = Array.isArray(parsed.stops) ? parsed.stops : [];
    return stops.length > 0 ? stops : DEFAULT_FAVOURITES;
  } catch (e) {
    console.log('loadFavourites: failed to parse stored favourites: ' + e);
    return DEFAULT_FAVOURITES;
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

function parseOvapiDate(dateString, referenceTimestamp) {
  if (!dateString) return NaN;

  // Get timezone offset from OVapi LastUpdateTimeStamp
  // Example: 2026-07-19T15:43:06+0200
  var offset = "+0100";

  if (referenceTimestamp) {
    var match = referenceTimestamp.match(/([+-]\d{4})$/);
    if (match) {
      offset = match[1];
    }
  }

  // Add timezone offset
  var iso = dateString + offset.substring(0, 3) + ":" + offset.substring(3);

  return new Date(iso).getTime();
}

// OVapi's /tpc/{code} response is nested
// Each journey has ExpectedArrivalTime / TargetArrivalTime, Destination info, LinePublicNumber.
function parseOvapiResponse(data) {
  var departures = [];
  var now = Date.now();

  Object.keys(data).forEach(function (stopCode) {
    var stop = data[stopCode];

    if (!stop.Passes) return;

    Object.keys(stop.Passes).forEach(function (journeyId) {
      var j = stop.Passes[journeyId];

      var etaString = j.ExpectedArrivalTime || 
                      j.ExpectedDepartureTime || 
                      j.TargetArrivalTime;

      if (!etaString) return;

      // OVapi timestamps have no timezone, assume local time   
      var etaMs = parseOvapiDate(
        etaString,
        j.LastUpdateTimeStamp
      );
      if (isNaN(etaMs)) return;
      
      console.log("OV time:", etaString, "parsed:", etaMs);

      var minutes = Math.round((etaMs - now) / 60000);
      if (minutes < 0) minutes = 0;

      departures.push({
        line: j.LinePublicNumber || '?',
        direction: j.DestinationName50 || j.DestinationName || '',
        transportType: j.TransportType || '',
        operator: j.OperatorCode || '',
        etaMs: etaMs,
        minutes: minutes,
        stopName: j.TimingPointName || '',
        journeyNumber: j.JourneyNumber || ''
      });
    });
  });

  // Sort by soonest departure
  departures.sort(function (a, b) {
    return a.etaMs - b.etaMs;
  });

  return departures;
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

/*  navigator.geolocation.getCurrentPosition(
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
  */
  
  fetchDeparturesForStop(loadFavourites()[0], function(dep) {
    console.log(JSON.stringify(dep));
    sendDeparturesToWatch(dep);
});
}

// ---------------------------------------------------------------------
// Config screen (embedded template, opened as a data: URI)
// ---------------------------------------------------------------------
//
// This mirrors config/config.html — if you edit the UI there for
// development/readability, copy the change into this string too.
// Keeping it inline avoids needing to host the config page externally,
// which Pebble's showConfiguration flow would otherwise require.

var CONFIG_PAGE_URL = 'https://schqual.github.io/nl-ov-departures/config/config.html';

function buildConfigUrl() {
  var favourites = loadFavourites();
  return CONFIG_PAGE_URL + '?stops=' + encodeURIComponent(JSON.stringify(favourites));
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
