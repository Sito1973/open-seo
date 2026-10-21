# 0008 — Local Rank Tracking: Location Data & Search

How city/region-level rank tracking stores and searches DataForSEO's location
registry, and why it works the way it does. Shipped July 2026; future
directions are listed at the end.

## The feature

Rank tracking configs take an optional `location_name` — a canonical DataForSEO
location string like `Enid,Oklahoma,United States`. Null means the existing
country-level behavior, unchanged. Uniqueness is enforced by two partial
indexes: one config per (project, domain, country) for national trackers, one
per (project, domain, country, location) for local ones.

When set, the location flows through verbatim:

- **SERP checks** (live and queued task-post) send `location_name` instead of
  `location_code`, so positions reflect what a searcher in that city sees.
  SERP pricing is location-independent, so cost estimates are unchanged.
- **Keyword metrics** come city-scoped: volume / CPC / competition from Google
  Ads `search_volume` (the only DataForSEO source that accepts sub-country
  geotargets), merged per keyword with national KD / intent from Labs (which
  is country-only). This matters: "rv storage near me" is 135K/mo nationally
  but 70/mo in Pittsburgh — a national number on a local tracker overstates
  demand by orders of magnitude. Keywords Google Ads collapses away get
  explicit nulls rather than a leaked national value; the UI column reads
  "Local volume" and exports name the city. Adds ~$0.09 per metrics refresh.
- **The picker** is a debounced combobox in the config modal, searching the
  country's registry and storing the selected canonical name. Local mode
  requires a selection; switching country clears it.

## Location data: how search works

The registry endpoint (`/v3/serp/google/locations/{iso}`) is free but has no
search parameter and returns the full country list per call — 9.5 MB / 60k
entries for the US. Slimmed to the five types users target (City, County,
Municipality, DMA Region, Region) it is ~23k entries / 1.5 MB. The data
changes roughly quarterly (Google geotarget updates).

The search path: combobox (350 ms debounce) → `searchSerpLocations` server fn
→ per-country list from **KV** (`serp-locations:{iso}`, 30-day
`expirationTtl`, hot reads edge-cached with `cacheTtl: 86400`) → substring
filter, top 10. A KV miss triggers the origin fetch + slim + store, with
concurrent cold fills coalesced in-isolate so the prewarm and a fast first
keystroke can't both download the 9.5 MB payload.

Selecting **Local** in the modal fires `prewarmSerpLocations` (a `useQuery`
keyed on country, `staleTime: Infinity`), so the one slow cold fill (~3 s)
usually happens before the first keystroke. Warm searches are tens of ms.

## Why KV

| Alternative                  | Why not                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers Cache API layer      | Documented no-op on workers.dev (self-hosters), per-colo only, no persistence guarantees. KV's `cacheTtl` provides the same hot-read caching, managed.   |
| R2 (+ cache in front)        | Works (an earlier iteration shipped it) but needs a second layer for read latency; KV is one primitive with the same profile.                            |
| D1 / Postgres table          | Schema + migrations on two providers for quarterly-static reference data; revisit if server-side validation or MCP location search justify a real table. |
| Durable Object per country   | Pins to its first-request region forever; new binding for self-host; buys coordination this read-only data doesn't need.                                 |
| Static assets, client search | Refresh requires redeploy — self-hosters would be pinned to release-time snapshots.                                                                      |
| "Just accept zip codes"      | Doesn't avoid the registry: DataForSEO only accepts canonical values, and zips are registry entries themselves (~32k for the US).                        |

Cost is noise either way: KV bills per operation, so storage for all supported
countries is ~$0.02/month and each search read is fractions of a cent.

## Self-hosted installs without DataForSEO

DataForSEO's registry is a copy of Google Ads' geo targets: its location codes
are criteria IDs and its location names are canonical names. A self-hosted
install that does not use DataForSEO for these features (no key, or a key kept
to backlinks) fills the same KV entry, with the same shape, types and 30-day
TTL, from the geo targets file Google publishes as a CSV inside a zip. The rest
of the stack (picker, `search_serp_locations`, research and SERP checks) cannot
tell the two sources apart, and a config saved under one stays valid under the
other.

- **Fetch:** one dated file URL pinned in code. The zip holds a single deflated
  CSV with its size in the local file header, so it is unpacked with the
  runtime's `DecompressionStream('deflate-raw')` and no zip library. The ~23 MB
  CSV is streamed line by line and only the requested country's lines are
  parsed (papaparse), so it is never held whole in memory.
- **Filter:** country code, `Active` status, and the same five types.
- **Validation:** with no DataForSEO sandbox to ask, saving a config checks its
  `location_name` against this registry, failing open when the file cannot be
  loaded, as the sandbox check does. Live SERP requests check a query's city
  the same way before spending a request, since an unknown `uule` name silently
  returns country-wide results.

| Alternative                                 | Why not                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Discover the newest file from the docs page | Scrapes an HTML page for a link; a redesign breaks it. A pinned file changes only when code changes it. |
| Google Ads `SuggestGeoTargetConstants`      | Needs the owner's Ads OAuth and API access for a lookup that should work before any setup.              |
| A zip library                               | One known layout needs a 30-byte header read, which the platform's decompression already covers.        |

Colombia shows why the picker always displays the full canonical name: the
file has two "Pereira" cities, `Pereira,Risaralda,Colombia` and
`Pereira,Pereira,Risaralda,Colombia`.

## Future directions (not built)

- **Picker quality**: prominence-ranked results (offline GeoNames/Census tier
  table — the registry has no population data, so "Portland" currently ranks
  the Maine DMA above Portland, OR), cities-first with a type filter,
  recently-used/suggested locations (must come from our own config history —
  GSC has no city dimension), and a selection-confirmation line.
- **ZIP fast path**: numeric queries search a separate cached Postal Code
  blob; useful for sub-metro service areas inside large cities.
- **Multi-city fan-out**: multi-select in the picker creating one config per
  city with a shared keyword set — the agency 3–5-metro workflow.
- **Server-side `location_name` validation** at config save, closing the gap
  where a hand-crafted request can store an arbitrary string (fails at
  DataForSEO at cost 0 today, so client-side validation suffices).
