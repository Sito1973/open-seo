# Free Google APIs for self-hosted installs

Some OpenSEO features can run on free Google APIs when your self-hosted install
has no DataForSEO key. Each one is opt-in: set its key and leave
`DATAFORSEO_API_KEY` unset.

When `DATAFORSEO_API_KEY` is set, OpenSEO keeps using DataForSEO and ignores
these keys. Features that have no Google replacement still need DataForSEO.

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
  **PageSpeed Insights API**.
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
`dataforseo` check says that free Google APIs cover the Lighthouse checks.

### 4) Check your quota

The API's **Quotas** page in the Cloud Console shows your daily and per-minute
limits and how much you have used. The defaults are far above what audits use.
If a check fails (quota, timeout, or a page Lighthouse could not load), the
audit marks that one check as failed and carries on.

## Google Places: Maps rank grid, local SERP and business search

With `GOOGLE_PLACES_API_KEY` set, three MCP tools run on the
[Places API (New)](https://developers.google.com/maps/documentation/places/web-service/op-overview)
Text Search instead of DataForSEO:

- `get_local_rank_grid`: one search per grid point.
- `get_local_serp_results`: the `maps` search type only. `local_finder` still
  needs DataForSEO.
- `search_local_businesses`: searches by `query`, or by the first category when
  no query is given. The `isClaimed` filter still needs DataForSEO, because
  Places does not say whether a listing is claimed.

The tools keep their names and output shapes. Their responses add
`provider: "google_places"`, the Google Maps attribution and the month's budget.

These tools still need DataForSEO: `get_business_profile` (on Places, a
`search_local_businesses` row already holds the full listing),
`get_business_reviews`, `get_business_updates`, `get_google_business_questions`
and `list_business_categories`.

### Built-in monthly budget

Unlike PageSpeed Insights, the Places API needs a billing account. Google gives
each billing account a free monthly allowance per SKU, and OpenSEO stays under
it with hard-coded budgets that reset at the start of each month, Pacific time:

| What OpenSEO sends                                                        | Google SKU             | Free per month | OpenSEO budget |
| ------------------------------------------------------------------------- | ---------------------- | -------------- | -------------- |
| One rank grid point (3x3 grid = 9, 5x5 grid = 25)                         | Text Search Pro        | 5,000          | 4,500          |
| One page of up to 20 local SERP or business search rows (at most 3 pages) | Text Search Enterprise | 1,000          | 900            |

OpenSEO counts each request before sending it. When the budget for a SKU runs
out, the tool says so and sends nothing until next month. A rank grid reserves
all of its points up front, so it either runs whole or not at all. Failed
requests still count, so the counter can run slightly ahead of Google's.

There is no setting to raise the budgets. The free allowance belongs to the
billing account, so use a billing account that no other Google Maps Platform
project shares. Otherwise the other project's usage counts against the same
allowance and you can be charged.

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

- On the Places API (New) **Quotas** page, lower the Text Search request quota
  so a runaway client cannot send many requests at once.
- Under **Billing → Budgets & alerts**, create a budget of $1 with an email
  alert. Google only sends the alert; it does not stop charges.

### 4) Set the environment variable

```bash
GOOGLE_PLACES_API_KEY=your-key
```

Recreate the container as in the PageSpeed Insights section. With DataForSEO
unset, the `dataforseo` check in `/api/health` lists Google Places among the
free Google APIs in use.

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
ratings, review counts, hours and coordinates) in the chat and out of
`save_report` and `update_project_context`. Reports can keep place IDs, ranks,
grid coordinates, your own business details and the agent's conclusions. Show
the "Google Maps" attribution when you present the results.

Do not set `OPENROUTER_API_KEY` (SAM, the in-app agent) on an install that uses
Google Places. SAM saves its chat history, which would store Places results.
