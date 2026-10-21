# Free Google APIs for self-hosted installs

Some OpenSEO features can run on free Google APIs, including your own
[Google Ads account's Keyword Planner](#google-ads-keyword-planner-search-volume-and-keyword-ideas),
or on the free tier of
[Bright Data](#bright-data-live-google-serp-for-rank-tracking), when your
self-hosted install has no DataForSEO key. Each one is opt-in: set its key and
leave `DATAFORSEO_API_KEY` unset.

When `DATAFORSEO_API_KEY` is set, OpenSEO keeps using DataForSEO and ignores
these keys, except for the
[Chrome UX Report tool](#chrome-ux-report-real-user-core-web-vitals): DataForSEO
has no real-user field data, so that tool runs on the PageSpeed Insights key
either way. Features that have no Google replacement still need DataForSEO.

These keys work on Docker self-hosting, including platforms that run the Docker
image for you. The Cloudflare deploy requires a DataForSEO key, so it always
uses DataForSEO.

## PageSpeed Insights: site audit Lighthouse checks

With `GOOGLE_PAGESPEED_API_KEY` set, the site audit runs its Lighthouse checks
through the [PageSpeed Insights API](https://developers.google.com/speed/docs/insights/v5/about).
It returns the same Lighthouse report DataForSEO does, so the audit shows the
same scores, metrics and issues. The API is free and needs no billing account,
but Google rejects requests without a key.

Each audit checks up to 10 pages, each on mobile and desktop, so it makes at
most 20 requests. Google loads those pages from its own servers, so they must be
publicly reachable.

### 1) Enable the API

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create
   a project (or pick an existing one).
2. Enable the
   [PageSpeed Insights API](https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com)
   for that project.

### 2) Create and restrict a key

Under **APIs & Services → Credentials → Create credentials → API key**, create a
key, then edit it:

- **API restrictions:** choose **Restrict key** and select only the
  **PageSpeed Insights API**, plus the **Chrome UX Report API** if you want
  [real-user Core Web Vitals](#chrome-ux-report-real-user-core-web-vitals).
- **Application restrictions:** choose **None**, or **IP addresses** if your
  server's outbound IP address never changes. Do not use **Websites** (HTTP
  referrers): OpenSEO calls the API from the server, not from a browser, so
  every request would be refused.

### 3) Set the environment variable

Add the key to `.env` and recreate the container:

```bash
GOOGLE_PAGESPEED_API_KEY=your-key
```

```bash
docker compose up -d --force-recreate open-seo
```

On a platform that runs the image for you, set the variable in its environment
settings and redeploy.

`/api/health` confirms the key reached the app: with DataForSEO unset, the
`dataforseo` check says that stand-in providers cover the Lighthouse checks.

### 4) Check your quota

The API's **Quotas** page in the Cloud Console shows your daily and per-minute
limits and how much you have used. The defaults are far above what audits use.
If a check fails (quota, timeout, or a page Lighthouse could not load), the
audit marks that one check as failed and carries on.

## Chrome UX Report: real-user Core Web Vitals

The PageSpeed Insights key also runs the `get_core_web_vitals` MCP tool, with or
without `DATAFORSEO_API_KEY`. It reads real-user field data from the
[Chrome UX Report (CrUX) API](https://developer.chrome.com/docs/crux/api) and
the [CrUX History API](https://developer.chrome.com/docs/crux/history-api). It
works for any public site, so you can compare your sites with your competitors'.
The site audit's Lighthouse checks measure one lab page load from Google's
servers; CrUX reports what real Chrome visitors experienced.

For up to 5 sites per call, on phone and desktop (or all devices combined), the
tool returns:

- the 75th percentile (p75) of LCP, INP, CLS, FCP and TTFB over the last 28
  days, rated good, needs improvement or poor with Google's thresholds;
- the share of page loads in each of those three ratings;
- Google's Core Web Vitals assessment: passed when LCP, CLS and INP (when INP
  has data) are all good;
- with `historyWeeks`, up to 40 weekly p75 values, each over the 28 days ending
  that week.

Ask for a single page with `level: "url"`. It needs far more traffic than the
whole site.

### 1) Enable the API

1. In the Google Cloud project of your PageSpeed Insights key, enable the
   [Chrome UX Report API](https://console.cloud.google.com/apis/library/chromeuxreport.googleapis.com).
2. If the key has API restrictions, add the **Chrome UX Report API** to them.

No new environment variable is needed, and the change applies without a
restart. Until the API is enabled, the tool answers with an error that names
the key.

### 2) Cost and quota

The CrUX API is free. Google allows 150 queries per minute per Cloud project,
shared by both CrUX endpoints, and does not sell more, so it cannot add charges.
A call sends one query per site and device, one more when a bare domain is
retried with `www.`, and one more for history: at most 30 queries for 5 sites.
When the per-minute quota runs out, the tool says so; wait a minute and retry.

### No data for a site

CrUX only includes sites and pages with enough Chrome visits in the last 28
days, and Google does not publish the threshold. Small sites often have none,
so the tool answers "no field data" for them instead of failing. Combining
devices (`device: "all"`) has data more often than phone or desktop alone. For
sites without field data, use the site audit's Lighthouse checks.

CrUX keys its data by the exact address visitors land on: `https://example.com`
and `https://www.example.com` are different sites. A bare domain such as
`example.com`, the form projects store their domain in, is tried as
`https://example.com` and then as `https://www.example.com`.

### What the numbers cover

- Chrome users worldwide on desktop and Android. Chrome on iOS, Android WebViews
  and other Chromium browsers such as Edge are not counted, and the CrUX APIs
  have no country filter.
- The daily data runs about two days behind. The history updates on Mondays.
- OpenSEO stores nothing from CrUX. For trends, ask for `historyWeeks` instead
  of keeping snapshots.

## Google Places: Maps rank grid, local SERP, business search and place details

With `GOOGLE_PLACES_API_KEY` set, three MCP tools run on the
[Places API (New)](https://developers.google.com/maps/documentation/places/web-service/op-overview)
Text Search instead of DataForSEO:

- `get_local_rank_grid`: one search per grid point. When the target has a
  `placeId`, each search asks Google for place IDs only, which Google does not
  bill. The target is then matched by `placeId` alone, and the grid's top
  results come back as place IDs without names. A target with only a `cid` or
  a `name` needs the business names and Maps links, which Google bills.
  `list_google_business_profile_locations` gives the place IDs of your own
  locations.
- `get_local_serp_results`: the `maps` search type only. `local_finder` still
  needs DataForSEO.
- `search_local_businesses`: searches by `query`, or by the first category when
  no query is given. The `isClaimed` filter still needs DataForSEO, because
  Places does not say whether a listing is claimed.

The tools keep their names and output shapes. Their responses add
`provider: "google_places"`, the Google Maps attribution and the month's budget
(null on a place-ID grid, which uses none).

A fourth tool, `get_place_details`, exists only on self-hosted installs that
use Google Places. It reads one place live from
[Place Details](https://developers.google.com/maps/documentation/places/web-service/place-details):
rating, review count, price level, primary type, opening hours, website,
whether it offers delivery, dine-in, takeout, reservations and outdoor seating,
and up to 5 reviews with their authors. Google picks the reviews by relevance,
so they are a sample, not the newest reviews or the full history. Pass it a
`place_id` from the other local tools to look at a competitor.

These tools still need DataForSEO: `get_business_profile` and
`get_business_reviews` (on Places, use `get_place_details`),
`get_business_updates`, `get_google_business_questions` and
`list_business_categories`.

### Built-in monthly budget

Unlike PageSpeed Insights, the Places API needs a billing account. Google gives
each billing account a free monthly allowance per SKU, and OpenSEO stays under
it with hard-coded budgets that reset at the start of each month, Pacific time:

| What OpenSEO sends                                                          | Google SKU                            | Free per month | OpenSEO budget |
| --------------------------------------------------------------------------- | ------------------------------------- | -------------- | -------------- |
| One rank grid point for a target with a `placeId`                           | Text Search Essentials (IDs Only)     | Unlimited      | None needed    |
| One rank grid point for a target with only a `cid` or `name` (3x3 grid = 9) | Text Search Pro                       | 5,000          | 4,500          |
| One page of up to 20 local SERP or business search rows (at most 3 pages)   | Text Search Enterprise                | 1,000          | 900            |
| One `get_place_details` call                                                | Place Details Enterprise + Atmosphere | 1,000          | 900            |

Except for place-ID rank grids, which Google does not bill, OpenSEO counts
each request before sending it. When the budget for a SKU runs out, the tool
says so and sends nothing until next month. A rank grid billed as Text Search
Pro reserves all of its points up front, so it either runs whole or not at all. Failed
requests still count, so the counter can run slightly ahead of Google's.

There is no setting to raise the budgets. The free allowance belongs to the
billing account, so use a billing account that no other Google Maps Platform
project shares. Otherwise the other project's usage counts against the same
allowance and you can be charged.

The counter covers one OpenSEO database. Do not put the same key, or a key
billed to the same account, on a second install (local development, staging):
each install counts only its own requests, so together they can pass the free
allowance. Give that install no Places key, or a key on a different billing
account.

The counter lives in OpenSEO's database. With Docker Compose that is the
`open_seo_data` volume mounted at `/app/.wrangler`. On a platform that runs the
image for you, mount a persistent volume at `/app/.wrangler`. If the volume is
lost, the counter starts again at 0 for the current month.

### 1) Set up billing and enable the API

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a
   project for OpenSEO and link it to a billing account that no other Maps
   project uses.
2. Enable the
   [Places API (New)](https://console.cloud.google.com/apis/library/places.googleapis.com).
   The legacy Places API is a different API and does not work.

### 2) Create and restrict a key

Create a separate API key under **APIs & Services → Credentials → Create
credentials → API key**, then edit it:

- **API restrictions:** choose **Restrict key** and select only the
  **Places API (New)**.
- **Application restrictions:** choose **None**, or **IP addresses** if your
  server's outbound IP address never changes. Do not use **Websites** (HTTP
  referrers).

### 3) Add a backstop

The built-in budget is the main guard. Add two more in the Cloud Console:

- On the Places API (New) **Quotas** page, lower the Text Search and Place
  Details request quotas so a runaway client cannot send many requests at
  once. Keep the Text Search per-minute quota at 60 or more: a 5x5 grid sends
  25 requests at once, and requests over the quota fail but still count
  against the monthly budget.
- Under **Billing → Budgets & alerts**, create a budget of $1 with an email
  alert. Google only sends the alert; it does not stop charges.

### 4) Set the environment variable

```bash
GOOGLE_PLACES_API_KEY=your-key
```

Recreate the container as in the PageSpeed Insights section. With DataForSEO
unset, the `dataforseo` check in `/api/health` lists Google Places among the
stand-in providers in use.

### Accuracy

Text Search is not the Maps app. It has no zoom, personalization or ads, so
ranks approximate what a person sees in Google Maps. Each grid point favors
results within one grid spacing of the point. Compare Google Places grids only with other
Google Places grids, not with grids from DataForSEO.

### What OpenSEO stores

OpenSEO stores only the monthly request counters. It keeps no Places results,
no cache and no rank history, and it adds no Places data to the app UI. Google's
terms limit how Places content can be stored and shown, so every response tells
your AI agent to keep listing details (names, addresses, phones, websites,
ratings, review counts, hours, coordinates and reviews) in the chat and out of
`save_report` and `update_project_context`. Reports can keep place IDs, ranks,
grid coordinates, your own business details and the agent's conclusions. Show
the "Google Maps" attribution when you present the results. When you show a
review, credit its author and Google Maps and link to the review on Google Maps.
`get_place_details` returns each review's author, author profile link and
Google Maps link for this.

SAM, the in-app agent, saves its chat history, which would store Places results.
So while Google Places is in use, SAM refuses the three search tools, and it
does not offer `get_place_details` at all. Run them from an MCP client instead.

## Bright Data: live Google SERP for rank tracking

Google has no API for its own search results. With `BRIGHTDATA_API_KEY` and
`BRIGHTDATA_SERP_ZONE` set, OpenSEO reads live Google results from
[Bright Data's SERP API](https://docs.brightdata.com/scraping-automation/serp-api/send-your-first-request)
instead of DataForSEO. Bright Data is a paid service, not a Google API, but its
free tier covers 5,000 requests a month, and OpenSEO stays under it.

It runs:

- **Rank tracking**, manual and scheduled. A keyword's position is the
  organic position of the tracked domain or one of its subdomains, as with
  DataForSEO, and its SERP features (local pack, People Also Ask, ads, and so
  on) come from the same pages. Scheduled checks also run live: Bright Data has
  no cheaper queue.
- **`get_serp_results`**: the organic results plus the local pack (name,
  rating, review count and link). Depth defaults to 10 here.
- **`find_serp_competitors`**: up to 10 keywords per call, from each keyword's
  live top 10 organic results. Each domain gets its keyword count, average and
  median position, and its position per keyword. Visibility and traffic
  estimates need search volumes, which a live results page does not have, so
  they are not returned, and only organic results are counted.

Each response says where its results came from, for example "Bright Data live
Google SERP from www.google.com.co (exit country CO, language es)". The rank
tracker says it in `get_rank_tracker` and `estimate_rank_tracker_cost`.

### How a request is built

Each request fetches one Google results page with about 10 organic results:

- **Country:** Bright Data sends it from an IP address in the project's
  country. For Colombia OpenSEO asks `www.google.com.co`: from a Colombian
  address, `google.com` with `gl=co` was refused with "redirect location was
  rejected". Other countries use `google.com` with `gl`, as Bright Data's docs
  describe. If checks for another country fail with that error, Bright Data
  could not follow Google's redirect for it.
- **Language and city:** `hl` is the tracker's or query's language. A tracker
  or query with a city adds Google's `uule` location parameter. Without
  DataForSEO, OpenSEO cannot look up or check city names, and
  `search_serp_locations` does not work. Pass Google's canonical name for the
  city, `City,Region,Country` with no spaces after the commas, for example
  `Pereira,Risaralda,Colombia`, as a tracker's or query's `locationName`. Google
  may ignore a name it does not recognize and return country-wide results.
- **Device:** mobile checks ask Bright Data for a mobile browser
  (`brd_mobile=1`); `get_serp_results` and `find_serp_competitors` use desktop.
- **Depth:** each further 10 results is one more request (`start=10`,
  `start=20`, …). A rank check stops at the page where the tracked domain
  appears, so a domain on page 1 costs one request whatever the tracker's
  depth.

A request takes 20 to 50 seconds. A rank check sends its keywords in batches
of 10, both devices at once, so 20 keywords on both devices take a few minutes.

OpenSEO does not ask for AI Overviews. Bright Data can request them
(`brd_ai_overview`), but on the tested zone those requests failed with "No
ready cookies". The `ai_overview` SERP feature appears only when Google shows
one on a normal results page.

### Built-in monthly budget

| What OpenSEO sends                                                       | Bright Data free tier | OpenSEO budget |
| ------------------------------------------------------------------------ | --------------------- | -------------- |
| One Google results page (a rank check, query or keyword sends 1 or more) | 5,000 per month       | 4,500          |

OpenSEO counts each request before sending it, and the budget resets on the
1st of each month, UTC. When it runs out, the tool or rank check says so and
nothing more is sent until next month. A rank check that runs out partway
saves the keywords it finished and reports the rest as not checked. Bright
Data does not bill failed requests, but OpenSEO still counts them, so its
counter can run ahead of Bright Data's.

For scale: four sites with 25 keywords each, checked weekly on both devices at
depth 10, send about 870 requests a month when every domain ranks on page 1.
A domain outside the top 10 costs one more request per 10 results of depth.

There is no setting to raise the budget. The counter shares the table and the
caveats of the [Google Places budget](#built-in-monthly-budget): it covers one
OpenSEO database, so do not put the same Bright Data account on a second
install, and it lives on the volume mounted at `/app/.wrangler`. If your Bright
Data billing period does not start on the 1st, the two months do not line up;
the 500-request margin absorbs some of that. On the free tier, Bright Data
stops answering at its own cap. If you add a payment method, also set a
monthly spend limit in Bright Data.

Bright Data's 5,000 free credits are one pool per account, shared with its Web
Unlocker API, Web Scraper API, Scraper Studio, Browser API and Bright Data's own
MCP server. OpenSEO's 4,500 is its own count, not a reservation: other usage on
the same account can use up the pool first, and OpenSEO's requests then fail
while its counter still shows budget left. Use a Bright Data account that runs nothing
else, or keep your other usage within the remaining 500 credits.

### 1) Create a SERP API zone

1. In the Bright Data control panel, add a **SERP API** zone.
2. Open the zone's **Overview** tab. It shows the zone name and the API key.

### 2) Set the environment variables

```bash
BRIGHTDATA_API_KEY=your-api-key
BRIGHTDATA_SERP_ZONE=your-zone-name
```

Recreate the container as in the PageSpeed Insights section. With DataForSEO
unset, the `dataforseo` check in `/api/health` lists Bright Data among the
stand-in providers in use. OpenSEO sends the key only in the `Authorization`
header.

### Accuracy

Google varies results by location, device, time and searcher. A Bright Data
check shows what a new visitor in the project's country (or the tracker's
city) sees, which can differ from what you see logged in. Compare Bright Data
positions with other Bright Data positions; DataForSEO checks from its own
locations.

### What OpenSEO stores

A rank check stores what a DataForSEO check stores: each keyword's position,
ranking URL and the names of the SERP features on the page. It keeps no copy
of the results page. `get_serp_results` keeps its rows for 12 hours, as
it does with DataForSEO, so repeating a call within that time sends no new
request. `find_serp_competitors` is not cached, so repeating it sends new
requests.

## Google Ads Keyword Planner: search volume and keyword ideas

The search volumes DataForSEO sells for keyword research come from Google Ads'
Keyword Planner. With the Google Ads variables below set and Google Ads
connected, OpenSEO reads them from your own Google Ads account through the
[Google Ads API](https://developers.google.com/google-ads/api/docs/keyword-planning/generate-keyword-ideas)
instead, for free. It runs:

- **`research_keywords`** and the app's keyword research page: keyword ideas
  for each seed from Keyword Planner, sorted by volume, with average monthly
  searches, the monthly trend and paid competition.
- **`get_keyword_metrics`**, refreshing saved keywords and a rank tracker's
  keyword metrics: volumes for a list of keywords, up to 700 per request.

Keyword Planner has no keyword difficulty or search intent, so those columns
stay empty, as they do for the countries DataForSEO serves from Google Ads
data. CPC also stays empty: Google reports bids in the Ads account's currency,
and OpenSEO shows CPC in US dollars. Google merges close variants such as
"hamburguesa" and "hamburguesas", and each keyword you asked for gets the
shared numbers; do not add them together.

### Locations and language

A country project sends its location code as the Google Ads geo target:
DataForSEO's location codes are Google Ads geo target IDs (Colombia is 2170).
For a city, county or region, pass Google's canonical name as `locationName`,
for example `Pereira,Risaralda,Colombia` (geo target 1003665). OpenSEO looks
the name up in Google Ads and rejects a name that is not a location in the
project's country. Ideas then stay national and the volumes become local, as
with DataForSEO. Without DataForSEO, `search_serp_locations` does not work, so
take the name from Google's
[geo targets table](https://developers.google.com/google-ads/api/data/geotargets).

The project's language becomes a Google Ads language (Spanish is 1003). A
language Google Ads does not offer is left out, which Google reads as every
language.

### Access level

Google retired developer tokens on September 9, 2026. The Google Ads API access
level now belongs to the Google Cloud project that owns the OAuth client in
`GOOGLE_ADS_CLIENT_ID`, and you manage it on that project's
[Google Ads API Overview](https://console.cloud.google.com/google/ads-apis/overview)
page. OpenSEO sends no developer token.

| Level    | Keyword Planner | Operations per day (production accounts) |
| -------- | --------------- | ---------------------------------------- |
| Explorer | Blocked         | 2,880                                    |
| Basic    | Allowed         | 15,000                                   |

Explorer is usually approved automatically but blocks Keyword Planner. Until
Basic is approved, keyword research answers "Google Ads API access pending
(Explorer level blocks Keyword Planner)" instead of failing with a generic
error. Brand verification of the Cloud project comes first: an OAuth consent
screen set to **Internal** has to be made **External** and **In production**,
with its branding filled in. Then apply for Basic on the Overview page; Google
may upgrade the project automatically after you apply.

Google's Required Minimum Functionality rules for keyword planning tools apply
only at Standard access. Keep the install for your own businesses: opening it
to other advertisers changes how Google classifies the tool.

### 1) Set up the Cloud project and OAuth client

In the Google Cloud project that will hold the access level:

1. Enable the
   [Google Ads API](https://console.cloud.google.com/apis/library/googleads.googleapis.com).
2. Complete the OAuth consent screen and brand verification as above.
3. Under **APIs & Services → Credentials**, create an **OAuth client ID** of
   type **Web application**, with this authorized redirect URI:
   `https://<your-openseo-host>/api/google-ads/oauth/callback`.
4. Apply for Basic access on the Google Ads API Overview page.

You also need a Google Ads account. The Google account you connect must be
able to open it, directly or through a manager account.

### 2) Set the environment variables

```bash
GOOGLE_ADS_CLIENT_ID=your-oauth-client-id
GOOGLE_ADS_CLIENT_SECRET=your-oauth-client-secret
# The Ads account to read, digits only.
GOOGLE_ADS_CUSTOMER_ID=1234567890
# Only when you reach that account through a manager account.
GOOGLE_ADS_LOGIN_CUSTOMER_ID=0987654321
```

`BETTER_AUTH_SECRET` must be set as well: it encrypts the stored Google grant,
as it does for Search Console. Recreate the container as in the PageSpeed
Insights section. With DataForSEO unset, the `dataforseo` check in
`/api/health` lists the Keyword Planner among the stand-in providers.

### 3) Connect Google Ads

Open any project's **Settings → Integrations** and use **Connect** on the
**Google Ads Keyword Planner** card. Google asks for the `adwords` scope, the
only scope the Google Ads API has. It allows changes to campaigns, but OpenSEO
only calls Keyword Planner and a read-only location lookup with it and never
changes anything in the account.

The grant belongs to the OpenSEO user who connected it, and keyword research
uses the grant of the user who runs it. **Disconnect** deletes the stored
grant; you can also remove OpenSEO's access in your Google account's security
settings. Hosted OpenSEO never offers this connection.

### Limits and caching

The Google Ads API does not bill API calls. Keyword Planner allows one request
per second per Ads account, and OpenSEO spaces its requests at least a second
apart, so a five-seed research call takes about five seconds. Each request is
one operation of the daily quota:

- a research seed sends one request;
- a city or region adds one location lookup and one volume request;
- `get_keyword_metrics` and refreshes send one request per 700 keywords.

Keyword Planner updates its numbers once a month, so OpenSEO keeps each answer
until the end of the calendar month (UTC) and repeats of the same request in
that month send nothing to Google. When Google reports a quota error, the tool
says so; try again later.

### Accuracy

Keyword Planner volumes are approximate monthly averages, rounded by Google.
Local, long-tail and brand keywords often come back small and rounded, or with
no volume at all. Some sources report coarser numbers for Ads accounts with
little or no spend; Google does not document a threshold for the API.

### What OpenSEO stores

The Google grant, encrypted like the Search Console grant. Keyword metrics are
stored in the project exactly as DataForSEO's are, so saved keywords show them.
The cached Keyword Planner answers expire after the month.
