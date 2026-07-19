# NL OV Departures

A Pebble Time 2 watch app that shows the next 5 Dutch public transport
departures (bus/tram/metro/train) from your nearest saved stops.

Data source: [OVapi.nl](https://github.com/skywave/OVAPI/wiki) — free,
no API key, covers all NL transit modes. NS's Reisinformatie API was
evaluated and ruled out, as it only covers train stations.

## How it works

- **Watch app** (`src/c/main.c`, C): a menu showing up to 5 departures
  (line, direction, minutes away). Refreshes every 30s automatically,
  or immediately on a SELECT button press.
- **Phone companion** (`src/pkjs/index.js`, PebbleKit JS): stores your
  favourite stops, checks phone GPS on each refresh, picks the nearest
  1–3 favourites, fetches their live departures from OVapi in one
  batch, merges and sends the soonest 5 to the watch.
- **Config screen** (`config/config.html`, and mirrored inline in
  `index.js`): add/edit/remove favourite stops, with a "use current
  GPS location" button to fill in lat/lon. Served as a `data:` URI so
  no external hosting is required.
- **CI** (`.github/workflows/build.yml`): builds the app via the
  official `rebble/pebble-sdk` Docker image on every push to `main`.

### Why a favourites list instead of live "nearest stop" search?

OVapi has no GPS search endpoint — the only coordinate source is a
~57,000-stop static GTFS file, too heavy to fetch/parse on-device on
every refresh. A curated favourites list, sorted by live GPS distance
at refresh time, is a deliberate tradeoff rather than an unfinished
feature.

## Local setup

```bash
# Install pebble-tool if you haven't already (see rebble docs):
# https://developer.rebble.io/developer.pebble.com/sdk/install/index.html

git clone <this repo>
cd nl-ov-departures
pebble build
pebble install --phone <phone-ip>   # or --emulator emery
```

## Adding favourite stops

1. Find OVapi TimingPointCodes for your stops. You can query
   `https://v0.ovapi.nl/tpc/` search tools or the GTFS `stops.txt`
   dump linked from the OVapi wiki to find codes for a given stop
   name.
2. Open the app's settings from the Pebble phone app.
3. Add each stop's name, TimingPointCode(s) (comma-separate if a stop
   has separate codes per direction), and either enter lat/lon
   manually or tap "Use current GPS location" while standing there.
4. Save. The watch app will refresh and start using the new list.

## Outstanding todos

- [ ] Push this repo to GitHub and confirm the Actions build actually
      succeeds — **untested**. May need PATH fixes for `pebble` inside
      the CI container; the workflow has a diagnostic step
      (`Diagnose pebble-tool`) to help track this down.
- [ ] Confirm `emery` is the correct Pebble Time 2 platform key for
      your installed `pebble-tool` version — currently an unverified
      assumption in `package.json`. Check with `pebble sdk list` or
      the pebble-tool release notes.
- [ ] Add real favourite stops (name, TPC codes, lat/lon) via the
      config screen and test on-device.
- [ ] Verify the config webview's geolocation actually gets phone
      location permission in practice; if it doesn't reliably, fall
      back to manual lat/lon entry (the UI already supports this as a
      fallback path).
- [ ] Test behaviour with multiple favourites at similar distances —
      does the nearest-N selection feel right, or does it flip
      between two nearby stops? See the hysteresis note in
      `pickNearestFavourites()` in `index.js` if so.
- [ ] Decide whether to amend the git committer email before the
      first push (currently whatever's in your local git config as a
      placeholder).
- [ ] Optional: evaluate CloudPebble's GitHub Repo Sync as an
      alternative to GitHub Actions if CI proves troublesome.

## Repo status

Initialized locally with these files; not yet pushed to GitHub. This
environment has no GitHub connector and no outbound network access, so
pushing and verifying the CI build need to happen from your own
machine/account:

```bash
git remote add origin <your-repo-url>
git push -u origin main
```
