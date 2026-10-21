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
