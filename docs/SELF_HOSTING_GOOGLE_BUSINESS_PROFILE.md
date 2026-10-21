# Self-hosted Google Business Profile

Connecting Google Business Profile lets an MCP client read your own listings:
the locations in your Business Profile account, their reviews with your
replies, daily performance (impressions, calls, direction requests, website and
menu clicks) and the search terms people used to find them.

This integration exists only on self-hosted installs. It reads data and never
changes your listings, but Google's only Business Profile scope
(`business.manage`) also allows edits, so OpenSEO keeps it off the hosted
service.

## What you'll need

- A Google account that owns or manages the Business Profile locations.
- A Google Cloud project with OAuth credentials. If Search Console or Google
  Analytics is already connected, reuse the same project and OAuth client.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `BETTER_AUTH_SECRET` set on
  the OpenSEO deployment.

## 1) Request Business Profile API access

Google gates the Business Profile APIs behind an access request. Until it is
approved, every API has a quota of 0 requests per minute and each call fails.

1. Check the
   [prerequisites](https://developers.google.com/my-business/content/prereqs):
   a Business Profile that has been verified and active for at least 60 days,
   with the business's website listed on it. Apply with an email that is an
   owner or manager of that profile.
2. Submit the
   [access request form](https://support.google.com/business/contact/api_default),
   choosing **Application for Basic API Access**, with your Google Cloud
   project number.
3. Wait for Google's email. Approval can take several days.

You can finish the other steps while you wait. To check the status, open
**APIs & Services → My Business Account Management API → Quotas** in the Cloud
Console: 0 queries per minute means the request is still pending, and 300 means
it was approved.

## 2) Enable the APIs

In the [Google Cloud Console](https://console.cloud.google.com/), enable all
four:

- [My Business Account Management API](https://console.cloud.google.com/apis/library/mybusinessaccountmanagement.googleapis.com)
  lists your Business Profile accounts.
- [My Business Business Information API](https://console.cloud.google.com/apis/library/mybusinessbusinessinformation.googleapis.com)
  lists their locations.
- [Google My Business API](https://console.cloud.google.com/apis/library/mybusiness.googleapis.com)
  reads reviews.
- [Business Profile Performance API](https://console.cloud.google.com/apis/library/businessprofileperformance.googleapis.com)
  reads daily metrics and search terms.

## 3) Configure the OAuth consent screen

Under **APIs & Services → OAuth consent screen**:

- With a Google Workspace account, choose the **Internal** user type. Refresh
  tokens then last until you revoke them.
- With an **External** app in **Testing**, add your Google account as a test
  user. Google expires refresh tokens for apps in Testing after 7 days, so you
  would have to reconnect every week. Moving the app to **In production**
  avoids that; Google then shows you an "unverified app" warning when you
  connect, which you can accept for your own account.

If your Google account belongs to a Google Workspace organization, its admin
must also turn on the Google Business Profile service for you (**Admin console
→ Apps → Additional Google services**).

## 4) Register the callback URL

Open **APIs & Services → Credentials**, edit the Web application OAuth client,
and add an authorized redirect URI matching the deployment origin plus
`/api/gbp/oauth/callback`.

| Deployment   | Redirect URI                                             |
| ------------ | -------------------------------------------------------- |
| Deployed     | `https://your-openseo-domain.com/api/gbp/oauth/callback` |
| Local Docker | `http://localhost:3001/api/gbp/oauth/callback`           |

Keep the existing `/api/gsc/oauth/callback` and `/api/ga4/oauth/callback` URIs
if those integrations use the same client.

## 5) Set environment variables

Set these values and restart OpenSEO. They are the same ones Search Console
and Google Analytics use.

| Variable               | Value                                                     |
| ---------------------- | --------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`     | Web application client ID.                                |
| `GOOGLE_CLIENT_SECRET` | Web application client secret.                            |
| `BETTER_AUTH_SECRET`   | Random string of at least 32 characters for token crypto. |

## 6) Connect a project

Open **Project settings → Integrations → Google Business Profile**, click
**Connect**, approve access, and choose a Business Profile account. Google asks
for this consent separately from Search Console and Analytics, so each
connection can be removed on its own.

A project binds one Business Profile account, and every location in it is
available to the tools. When the account holds several locations, the tools
use the one whose website matches the project's domain. Otherwise they ask the
agent to pass a `location` from `list_google_business_profile_locations`. If
each of your brands has its own website and project, every project finds its
own location without extra setup.

## MCP tools

These tools appear only on a self-hosted `/mcp` endpoint, so connect your MCP
client directly to your own server:

- `list_google_business_profile_locations`: the account's locations, with Place
  IDs you can pass to `get_local_rank_grid`.
- `get_google_business_profile_reviews`: reviews with ratings, your replies and
  a count of unanswered ones. OpenSEO never posts replies.
- `get_google_business_profile_performance`: daily impressions and actions for
  up to 92 days.
- `get_google_business_profile_search_keywords`: monthly search terms.

## What OpenSEO stores

Google's Business Profile API policies limit how long its content may be kept.
OpenSEO stores only the selected account's name and ID, which Google account
connected it, and the encrypted OAuth tokens. Reviews, metrics and search terms
are fetched when a tool runs and are never saved. Each tool response asks the
agent to keep that content out of saved reports and project context.

## Troubleshooting

**"Business Profile API access is pending Google's approval"**: the access
request from step 1 has not been approved yet, or one of the APIs from step 2
is not enabled.

**No accounts appear**: make sure you connected the Google account that owns or
manages the Business Profile.

**Connection expired every week**: the OAuth app is External and in Testing.
See step 3.

**`redirect_uri_mismatch`**: the registered URI must match the scheme, host,
port, and `/api/gbp/oauth/callback` path of the deployment exactly.
