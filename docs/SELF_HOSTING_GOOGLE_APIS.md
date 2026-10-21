# Free Google APIs for self-hosted installs

Some OpenSEO features can run on free Google APIs, including your own
[Google Ads account's Keyword Planner](#google-ads-keyword-planner-search-volume-and-keyword-ideas),
or on the free tiers of
[Bright Data](#bright-data-live-google-serp-for-rank-tracking) and
[SerpApi](#serpapi-google-ai-mode-for-ai-visibility), when your self-hosted
install has no DataForSEO key. Each one is opt-in: set its key and leave
`DATAFORSEO_API_KEY` unset, or
[keep DataForSEO to backlinks](#dataforseo-for-backlinks-only).

When `DATAFORSEO_API_KEY` is set for every feature, OpenSEO keeps using
DataForSEO and ignores these keys, except for the
[Chrome UX Report tool](#chrome-ux-report-real-user-core-web-vitals): DataForSEO
has no real-user field data, so that tool runs on the PageSpeed Insights key
either way. Features that have no Google replacement still need DataForSEO.

These keys work on Docker self-hosting, including platforms that run the Docker
image for you. The Cloudflare deploy requires a DataForSEO key, so it always
uses DataForSEO.

## DataForSEO for backlinks only

No Google API reports the links that point at a site, so backlinks need
DataForSEO. Its Backlinks API is pay-as-you-go with no monthly minimum: $0.024
per request plus $0.000036 per row returned. To pay DataForSEO for backlinks
alone and run every other feature on the keys in this guide, set both:

```bash
DATAFORSEO_API_KEY=your-base64-credentials
DATAFORSEO_SCOPE=backlinks
```

Then:

- The Backlinks page, the backlink cards on the project dashboard, and the
  `get_backlinks_overview` and `get_backlinks_profile` MCP tools read
  DataForSEO.
- Every other feature behaves exactly as if `DATAFORSEO_API_KEY` were unset: it
  runs on the key from this guide that covers it, or stays unavailable. Nothing
  else is sent to DataForSEO.
- The app shows no missing-key warning, because a DataForSEO key is set.

`backlinks` is the only accepted value. Any other value stops the container at
startup. A platform that runs its own start command skips that check, so
OpenSEO also treats any other value as `backlinks`: a typo can never send every
feature to DataForSEO. Leave `DATAFORSEO_SCOPE` unset to use DataForSEO for
everything. Hosted OpenSEO ignores it.

### Monthly request budget

| What OpenSEO sends                            | DataForSEO price           | OpenSEO budget         |
| --------------------------------------------- | -------------------------- | ---------------------- |
| One Backlinks API request of up to 1,000 rows | $0.024 + $0.000036 per row | 300 requests per month |

OpenSEO counts each request before sending it, failed requests included, never
retries a failed one on its own, and refuses a request that could return more
than 1,000 rows, DataForSEO's own maximum. When the month's requests run out,
backlinks say the monthly budget is used up, and nothing is sent until the 1st
of the next month, UTC. A month therefore costs at most
300 × ($0.024 + 1,000 × $0.000036) = $18. The app never asks for more than 200
rows (the largest page size), so in practice the most is 300 × $0.0312 = $9.36.

| What you do                                                        | Requests                 |
| ------------------------------------------------------------------ | ------------------------ |
| Open the backlinks overview of a domain or URL                     | 1 or 2                   |
| Open one page of the Backlinks, Referring domains or Top pages tab | 1                        |
| Open a project dashboard (its link activity card)                  | 1 or 2 per project a day |
| Open a tab of the dashboard's Backlinks section                    | 1 per project a day      |

OpenSEO reuses a backlinks result for 6 hours, and a dashboard card for 24
hours, so repeating a lookup within that time sends nothing. Opening a project
dashboard and all three tabs of its Backlinks section every day still uses up to
4 requests per project a day, about 120 a month. Raise the budget if you check
more than two projects that way.

To change the budget, set `DATAFORSEO_BACKLINKS_MONTHLY_REQUESTS` to a whole
number of requests per month. The most a month can cost is that number ×
$0.06.

```bash
DATAFORSEO_BACKLINKS_MONTHLY_REQUESTS=500
```

The counter shares the table and the caveats of the
[Google Places budget](#built-in-monthly-budget): it covers one OpenSEO
database, so requests from another install or tool with the same DataForSEO
account come on top. DataForSEO bills a prepaid balance, which is a second
limit: requests fail once it runs out.

Recreate the container as in the PageSpeed Insights section. `/api/health`
then reports the `dataforseo` check as set for backlinks only, with the budget
and the stand-in providers it found.

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
  no cheaper queue, but they can reuse a first page OpenSEO already has (see
  [Saved first pages](#saved-first-pages)).
- **`get_serp_results`**: the organic results plus the local pack (name,
  rating, review count and link). Depth defaults to 10 here. From the first
  results page it also returns the featured snippet, People Also Ask (question,
  answer and source), the AI Overview (its text and cited sources), the
  knowledge panel, ads (top and bottom) and related searches, as rows typed
  with DataForSEO's names (`featured_snippet`, `people_also_ask`,
  `ai_overview`, `ai_overview_reference`, `knowledge_graph`, `paid`,
  `related_searches`). These rows rank within their own section. If Bright
  Data changes the shape of one section, that section is left out and the rest
  of the page still comes back.
- **`find_serp_competitors`**: competitors from each keyword's first results
  page, the top 10 organic results and the local pack. A keyword with a
  [saved first page](#saved-first-pages) from the last 14 days costs nothing,
  so a call can cover all of a project's tracked keywords; the others are
  searched live, at most 10 per call (repeat the call for the next 10). On
  the project's own market it searches near the city of the project's rank
  tracker, on mobile when that tracker checks mobile only. See
  [Competitors and visibility](#competitors-and-visibility).
- **The SERP Analysis card** in keyword research: the top 20 organic results
  (two requests), and up to 50 when you page past them ("Load top 50").
  Google pages by offset here, so loading more sends requests only for
  pages 3 to 5 and adds them to the snapshot already cached for 12 hours.
  Traffic estimates and backlink counts per result come from DataForSEO and
  stay empty.
- **Competitor search during project setup** (the AI visibility setup screen,
  `research_project_website` and `complete_ai_research_setup`): one request
  per search, top 10 plus the local pack, near the city of the project's rank
  tracker when it has one. See
  [Setup without an AI model](#setup-without-an-ai-model) for installs
  without `OPENROUTER_API_KEY`.
- **Google AI Overviews in AI visibility tracking**: one request per prompt
  in each check, reading the AI Overview on that results page. See
  [Google AI Overviews for AI visibility](#google-ai-overviews-for-ai-visibility).
- **Keyword difficulty estimates**: from the first pages rank checks save, at
  no cost, and on demand at most 300 requests a month. See
  [Keyword difficulty estimates](#keyword-difficulty-estimates-bright-data-and-open-pagerank).

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
  (`brd_mobile=1`); `get_serp_results` uses desktop, and
  `find_serp_competitors` uses mobile only for a project whose rank tracker
  checks mobile only.
- **Depth:** each further 10 results is one more request (`start=10`,
  `start=20`, …). A rank check stops at the page where the tracked domain
  appears, so a domain on page 1 costs one request whatever the tracker's
  depth. Requests without a tracked domain (`get_serp_results`, the SERP
  Analysis card) send all their pages at once, so a deeper request takes about
  as long as one page; results after an empty page are dropped.

A request takes 20 to 50 seconds. A rank check sends its keywords in batches
of 10, both devices at once, so 20 keywords on both devices take a few minutes.

OpenSEO does not ask for AI Overviews. Bright Data can request them
(`brd_ai_overview`), but on the tested zone those requests failed with "No
ready cookies". The `ai_overview` SERP feature appears only when Google shows
one on a normal results page. Google loads some AI Overviews after the page,
so `get_serp_results` reports a page without one as "not detected", not as
proof that Google shows none for that query.

### Saved first pages

OpenSEO saves the first results page of every Bright Data request, from rank
checks, `get_serp_results`, `find_serp_competitors`, the SERP Analysis card,
project setup searches and Google AI Overviews checks: the keyword, market
(country, language and city), device and time, the organic results and the
local pack (position, domain, link, title, and the pack's rating and review
count), and the page's SERP features. Later pages are not saved. The pages
belong to the organization that asked for them and are deleted with it.

A scheduled rank check first looks for a saved first page of the same search
(same keyword, market and device) from the last 3 days. If the tracked domain
is on it, the check sends no request; if not, it sends requests only for
pages 2 onward. So when two of your sites track "hamburguesas pereira" on
mobile in the same city and their weekly checks run within 3 days of each
other, the second check reuses the first one's page. The check's date is the day it ran, even when its page 1 is up to 3
days older. A manual check ("Check rankings" or `run_rank_tracker`) always
fetches live, and saves the page it gets.

`find_serp_competitors` reads the latest saved first page of each keyword
from the last 14 days, in the same market and from either device, before it
searches anything. Weekly rank checks keep every tracked keyword inside that
window.

`get_serp_results` does not answer from saved pages, because they keep only
the organic results and the local pack, not People Also Ask, ads or the AI
Overview. It keeps its own 12-hour cache. Rank checks never mix desktop and
mobile pages: `get_serp_results` asks for desktop, so only a desktop tracker
can reuse its pages, and `find_serp_competitors` asks for the device of the
project's tracker.

### Competitors and visibility

`find_serp_competitors` lists every site on those first pages: organic results
by domain, and local pack listings by their website. A listing that links to
a social or delivery profile (Instagram, Facebook, Linktree, WhatsApp, Rappi),
to Google, or to no site is listed by its business name instead. Each
competitor gets its keyword count, its organic position per keyword (average
and median) and its local pack position per keyword.

Visibility and traffic are OpenSEO estimates, not Google data. They come from
one click-through-rate curve by position (27.6% at #1 down to 2.4% at #10),
40% lower on a page where an AI Overview was detected. A competitor with both
an organic result and a local pack listing on a keyword gets the better of
the two.

- **Visibility**: the competitor's clicks across the keywords as a share of
  what a #1 on every keyword would get, from 0 to 1.
- **`etv`**: Keyword Planner monthly searches times that click-through rate,
  summed over the keywords. It is empty without
  [Keyword Planner](#google-ads-keyword-planner-search-volume-and-keyword-ideas)
  volumes, including while Google has not granted Basic access.
- **`estimated_paid_traffic_cost`**: `etv` times the Keyword Planner CPC,
  empty while Keyword Planner returns no CPC.

Sort by `visibility` (the default), `traffic_estimate`, `avg_position` or
`keyword_count`. Paid results and featured snippets are not counted.

### Built-in monthly budget

| What OpenSEO sends                                                                                 | Bright Data free tier | OpenSEO budget |
| -------------------------------------------------------------------------------------------------- | --------------------- | -------------- |
| One Google results page (a rank check, query or keyword sends 1 or more; an AI Overviews answer 1) | 5,000 per month       | 4,500          |

OpenSEO counts each request before sending it, and the budget resets on the
1st of each month, UTC. When it runs out, the tool or rank check says so and
nothing more is sent until next month. A rank check that runs out partway
saves the keywords it finished and reports the rest as not checked. Bright
Data does not bill failed requests, but OpenSEO still counts them, so its
counter can run ahead of Bright Data's.

For scale: four sites with 25 keywords each, checked weekly on both devices at
depth 10, send about 870 requests a month when every domain ranks on page 1.
A domain outside the top 10 costs one more request per 10 results of depth.
Keywords that several sites track cost less, because scheduled checks reuse
saved first pages. Google AI Overviews tracking adds one request per prompt
per check: 40 prompts checked weekly send up to 200 a month.

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

### Google AI Overviews for AI visibility

With Bright Data set and no DataForSEO for other features, AI visibility
tracking offers **Google AI Overviews** as an engine, next to
[Google AI Mode](#serpapi-google-ai-mode-for-ai-visibility) when SerpApi is
set too. A new tracker starts on every engine the install collects. Run now
and scheduled checks both collect live: Bright Data has no cheaper queue.

- **Request:** the tracked prompt, exactly as saved, as a Google search from
  the tracker's country in its language, on desktop, as DataForSEO checks AI
  Overviews. There is no city: to ask about one, name it in the prompt. The
  page is one request and is saved with the
  [saved first pages](#saved-first-pages).
- **Answer:** the AI Overview's text (its paragraphs and list items) and the
  pages it cites, in Google's order. Brand mentions and citations are matched
  as for the other engines. Citations have no placement, as with DataForSEO.
- **No answer:** a page without an AI Overview counts as no answer, as with
  DataForSEO. So does a page where Google showed an AI Overview but Bright
  Data returned it without its text: the answer keeps the pages it cites and
  a note saying why, shows as "Answer without text", and is left out of
  visibility rates. Neither is ever counted as an answer that leaves your
  brand out.
- **Cost:** answers cost $0. Each one uses a request from the
  [4,500-request budget](#built-in-monthly-budget-1), which rank tracking and
  the SERP tools also use. Estimates show the requests a check uses, the most
  the schedules can use in one month and the requests left this month.
- **Before a check,** OpenSEO checks that every prompt fits the requests left
  this month; otherwise the check does not start and says why. A scheduled
  check shows the reason as the tracker's scheduling notice.
- **Schedules** must fit in their busiest month (up to 31 daily, 5 weekly or
  1 monthly check), together with every other enabled Google AI Overviews
  tracker on the install: saving or enabling one that could need more than
  4,500 requests in a month is refused. Rank tracking is not counted there,
  so leave room for it: the estimate shows what the budget has left.

OpenSEO does not ask Bright Data to wait for AI Overviews (`brd_ai_overview`,
which failed on the tested zone, see above). Google loads some AI Overviews
after the page, and those count as no answer, so the share of prompts with
an AI Overview comes out lower than DataForSEO's, which waits for them.
Compare AI Overviews results over several checks rather than single answers.

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
ranking URL and the names of the SERP features on the page. Every request's
first page also goes to the [saved first pages](#saved-first-pages).
`get_serp_results` keeps its rows for 12 hours, as it does with DataForSEO,
so repeating a call within that time sends no new request.
`find_serp_competitors` keeps no results of its own: repeating it reads the
first pages it saved, so it sends no new request for those keywords. The SERP
Analysis card and the searches of project setup and prompt suggestions also
keep their results for 12 hours.

## Keyword difficulty estimates: Bright Data and Open PageRank

DataForSEO's keyword difficulty has no Google equivalent, and Keyword Planner
has none. With [Bright Data](#bright-data-live-google-serp-for-rank-tracking)
set and no DataForSEO for other features, OpenSEO estimates it (0-100) from a
keyword's first Google results page. Estimates are labeled
**OpenSEO estimate**: a dashed badge with that label on hover in the app, and
`~N` with `keywordDifficultyEstimate` in the MCP tools. They are not
DataForSEO data, and where DataForSEO has a difficulty for a keyword, its
number is shown instead.

### How it is worked out

- **Local:** the local pack's median review count on a log scale: about 50
  reviews give 25, 500 give 58 and 3,000 give 84. For a restaurant search,
  how established the businesses in the pack are is most of the difficulty.
- **Organic:** the [Open PageRank](https://keywordseverywhere.com/openpagerank/docs)
  of the top 10 domains (0-10, times 10), averaged with OpenSEO's
  click-through-rate curve as weights so the top results count most, minus 10
  for each top-5 result on a social network, forum, directory or delivery
  platform (Facebook, Instagram, TikTok, Tripadvisor, Restaurant Guru, Rappi,
  Páginas Amarillas and similar), which a business's own page can pass. A
  domain Open PageRank does not know counts as 0.
- **Difficulty:** 0.6 × local + 0.4 × organic when the page has a local pack,
  and organic alone when it has none. Without `OPENPAGERANK_API_KEY` the
  organic part is not measured: a page with a local pack gets the local score,
  and a page without one gets no estimate.

### Where estimates come from

- **Tracked keywords**, after each rank check, from the first pages the check
  saved: no extra request. They show in the rank tracker's KD column and in
  `get_rank_tracker`.
- **Any other keyword**, on demand: select keywords in keyword research or
  Saved Keywords and choose **Estimate difficulty**, or call the
  `estimate_keyword_difficulty` MCP tool. A keyword with a
  [saved first page](#saved-first-pages) from the last 14 days costs nothing;
  at most 10 others per click or call are searched live, one Bright Data
  request each, near the city of the project's rank tracker on its device. Up
  to 50 keywords per click; repeat for the rest.

Each estimate belongs to the project, for one keyword, country and language,
and the latest one replaces the one before. It records the city and date of
the page it came from. Estimates live apart from the provider's metrics, so a
metrics refresh never erases them and saving keywords from research never
stores an estimate as provider data. Keyword research, Saved Keywords
(including its difficulty filter and sort), the rank tracker,
`research_keywords`, `list_saved_keywords` and `get_rank_tracker` show them.
CSV and Sheets exports keep the provider's difficulty only.

### Budgets

| What OpenSEO sends                                   | Free tier                | OpenSEO budget              |
| ---------------------------------------------------- | ------------------------ | --------------------------- |
| Live Google searches for on-demand estimates         | (Bright Data's 5,000)    | 300 a month, from the 4,500 |
| Open PageRank lookups (each domain counted per call) | 30,000 domains per month | 25,000 domains a month      |

Both reset on the 1st, UTC, and neither has a setting to raise it. Each
domain's Open PageRank is kept 30 days, so the same sites cost nothing in
later estimates. Past a budget, estimates from saved pages still work, and
the organic part is left out until next month.

### 1) Create an Open PageRank key (optional)

1. Create a free key on
   [Open PageRank](https://keywordseverywhere.com/openpagerank/docs).
2. Set the server's public IPv4 address on the account page. From 1 November
   2026 a free key answers only that address, so the server needs a fixed
   IPv4 address. Without one, leave the key unset and estimates use the local
   pack alone.
3. Set the environment variable and recreate the container:

```bash
OPENPAGERANK_API_KEY=your-key
```

OpenSEO sends the key only in the `Authorization` header, and only the
domains of the top 10 results. The `/api/health` preflight lists the estimates
among the stand-in providers in use.

### Accuracy

An estimate reads one page of one city on one day, so it moves with Google's
results. Compare estimates with each other, not with DataForSEO's difficulty,
which weighs the backlinks of the ranking pages; no free source offers those.

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
- **`find_serp_competitors`** on Bright Data: the volumes behind each
  competitor's estimated traffic (see
  [Competitors and visibility](#competitors-and-visibility)).

Keyword Planner has no keyword difficulty or search intent, so those columns
stay empty, as they do for the countries DataForSEO serves from Google Ads
data, except for OpenSEO's own
[difficulty estimates](#keyword-difficulty-estimates-bright-data-and-open-pagerank)
when Bright Data is set. CPC also stays empty: Google reports bids in the Ads account's currency,
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
settings. Hosted OpenSEO never offers this connection. With
`DATAFORSEO_API_KEY` set, the card appears only while you still have a grant
to disconnect.

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

## SerpApi: Google AI Mode for AI visibility

Google has no API for AI Mode answers either. With `SERPAPI_API_KEY` set, AI
visibility tracking collects Google AI Mode answers through
[SerpApi's Google AI Mode API](https://serpapi.com/google-ai-mode-api).
SerpApi is a paid service, not a Google API, but its free plan includes 250
searches a month, at most 50 an hour, and OpenSEO stays under both.

Without DataForSEO, a tracker can use Google AI Mode, and Google AI Overviews
when [Bright Data](#google-ai-overviews-for-ai-visibility) is set too:
ChatGPT, Gemini, Claude and Perplexity answers need DataForSEO. Tracking
settings offer only those engines, and a new tracker starts on them. A
tracker saved earlier with other engines does not run, and its scheduling
notice says why, until you switch it. With `DATAFORSEO_API_KEY` set for every
feature, Google AI Mode is not offered.

Run now and scheduled checks both work. Each prompt is one SerpApi search, and
an answer takes about 8 seconds. SerpApi has no cheaper queue, so scheduled
checks are collected the same way as Run now.

### How a search is built

- **Prompt:** the tracked prompt, exactly as saved.
- **Country and language:** `location` is the tracker's country name, for
  example `Colombia`, `gl` its country code and `hl` its language. AI
  visibility trackers are set per country, so there is no city: to ask about
  a city, name it in the prompt, for example "mejor hamburguesa en Pereira".
- **Device:** desktop, SerpApi's default.
- **Cache:** SerpApi answers a repeat of the same search within an hour from
  its cache and does not charge it. OpenSEO counts it anyway.

SerpApi takes the key only as a URL parameter. OpenSEO never logs those URLs
and removes the key from any error it reports.

### What an answer records

- **Answer text:** paragraphs, headings, lists (including the names of the
  businesses an answer lists) and tables. Brand mentions and citations are
  matched as for the other engines.
- **Cited pages,** in the order Google lists them.
- **Where each page is cited.** A page is _linked in the answer_ when the
  answer text links it, numbered by the order of the first links: #1 is the
  first cited page the text links. Otherwise it is in the _sources list only_.
  The answer page shows this on each citation, and `get_ai_visibility_answer`
  returns it as `placement` (`inline` or `reference`) and `inlineOrder`. When
  the answer text links no page at all, placement is not recorded.

A search where Google shows no AI Mode answer counts as no answer, as for AI
Overviews, and is left out of visibility rates.

### Built-in monthly budget

| What OpenSEO sends                                 | SerpApi free plan              | OpenSEO budget                    |
| -------------------------------------------------- | ------------------------------ | --------------------------------- |
| One search per prompt in each Google AI Mode check | 250 per month, at most 50/hour | 240 per month, at most 50 a check |

Answers cost $0, so cost estimates show $0 along with the searches a check
uses, the most the schedules can use in one month, and the searches left this
month. Every tracker on the install shares the 240 searches: the monthly
figure adds the schedule you are saving to every other enabled Google AI Mode
tracker, in any project. OpenSEO counts each search before sending it, failed
searches included, and the budget resets on the 1st of each month, UTC. There
is no setting to raise it.

- **Before a check,** OpenSEO checks that every prompt fits the budget left
  this month, and that SerpApi's own counts of searches left on the plan and
  searches left this hour (its account endpoint, which uses no search) cover
  them too. When SerpApi's counts cannot be read, a check may use up to 50
  searches. Otherwise the check does not start and says why. A scheduled check
  shows the reason as the tracker's scheduling notice. Due trackers that
  together need more than 50 searches do not start at once: the rest wait for
  the scheduler's next pass, which checks SerpApi's hourly count again.
- **During a check,** an answer that would go over the budget fails with a
  message saying so, and nothing is sent for it.
- **Schedules** must fit the budget in their busiest month: up to 31 daily
  checks, 5 weekly checks or 1 monthly check. Saving or enabling a schedule
  whose check needs more than 50 searches, or that, together with every other
  enabled Google AI Mode tracker on the install, could need more than 240
  searches in one month is refused. A single tracker can therefore have up to
  7 prompts daily, 48 weekly, or 50 monthly, less when other trackers already
  use part of the budget.

The counter shares the table and the caveats of the
[Google Places budget](#built-in-monthly-budget): it covers one OpenSEO
database, so do not put the same SerpApi account on a second install. SerpApi's
plan month starts on the date you signed up, not on the 1st; the check of
SerpApi's own counts before each check covers that difference. Searches made
by other tools with the same key count against both of SerpApi's limits.

### 1) Create a SerpApi account

Sign up at [serpapi.com](https://serpapi.com/) on the free plan and copy the
API key from your account page.

### 2) Set the environment variable

```bash
SERPAPI_API_KEY=your-api-key
```

Recreate the container as in the PageSpeed Insights section. With DataForSEO
unset, the `dataforseo` check in `/api/health` lists SerpApi among the
stand-in providers.

### 3) Switch tracking to Google AI Mode

Open **Prompt Tracking → Tracking settings** and select **Google AI Mode**
(and **Google AI Overviews** with Bright Data), the only engines offered.
Review the estimate, which shows the searches and requests, then save and use
**Run now** for a first answer.

### Accuracy

An answer shows what Google AI Mode told a new desktop visitor in the
tracker's country at that time. AI Mode answers change between searches, so
compare trends over several checks rather than single answers.

### What OpenSEO stores

What it stores for any engine: the answer text, the cited pages with where
the answer cites them, and each brand's mention and citation. It keeps no copy
of SerpApi's response.

## Setup without an AI model

OpenSEO drafts three things with a language model through OpenRouter: the
project setup research (business overview, verified competitors, five topics
with five prompts each, and Prompt Research keywords), and the prompts behind
**Generate** in Prompt Tracking. On a Docker install without
`OPENROUTER_API_KEY`, these return the raw material instead of drafts, so you,
or your own assistant connected over [MCP](https://openseo.so/docs/mcp), write
them. Hosted OpenSEO always drafts them.

**Project setup** (the AI visibility setup screen, `research_project_website`
and `complete_ai_research_setup`) returns:

- the pages it read from your website, with the overview prefilled from your
  homepage's text when none is saved;
- with [Bright Data](#bright-data-live-google-serp-for-rank-tracking), live
  Google results for the first two keywords the project tracks in Rank
  Tracking, near the tracker's city: organic results, the local pack, People
  Also Ask and related searches. Keywords that contain the project's name or
  domain are skipped, because they find the business itself. Each search is
  one Bright Data request;
- Prompt Research keyword candidates: your tracked keywords and Google's
  related searches.

The setup screen explains this, lets you rewrite the overview, add
competitors from Google's results with one click, and edit the keyword list.
It then saves the keywords without topics, so no prompts are tracked until you
add some. Setup always stops at this review, even when the overview and
competitors are already saved. Over MCP, the result carries `withoutModel`
with the same material and step-by-step guidance; the assistant drafts the
overview, competitors, topics and prompts, shows them to you, and saves them
with `save_project_website_setup`.

**Generate** in Prompt Tracking (and `generate_ai_visibility_prompts`)
returns Google's People Also Ask questions, then its related searches, for the
topic near the project's tracked city, from one Bright Data request, minus
prompts you already track. Without a topic, it uses the first Prompt Research
keyword that is not a topic yet. Edit them into questions a customer would ask
an AI assistant before saving. Without Bright Data, it returns no suggestions
and says so.
