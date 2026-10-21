# Self-hosted Google Business Profile

Connecting Google Business Profile lets an MCP client read your own listings:
the locations in your Business Profile account, their full profile, reviews
with your replies, daily performance (impressions, calls, direction requests,
website and menu clicks) and the search terms people used to find them.

It can also edit them, one change at a time and only after you approve it in
chat: categories, description, hours, website, phone numbers and attributes
such as delivery or the menu link. It can reply to reviews, publish posts and
change food menu items. See [How edits work](#how-edits-work).

This integration exists only on self-hosted installs. Google's only Business
Profile scope (`business.manage`) allows edits, so OpenSEO keeps it off the
hosted service.

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
  lists their locations and reads and edits the profile: categories,
  description, hours, website, phone numbers and attributes.
- [Google My Business API](https://console.cloud.google.com/apis/library/mybusiness.googleapis.com)
  reads reviews, posts review replies, publishes posts and edits the food
  menu.
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
  a count of unanswered ones.
- `get_google_business_profile_performance`: daily impressions and actions for
  up to 92 days.
- `get_google_business_profile_search_keywords`: monthly search terms.
- `get_google_business_profile_listing`: the full editable profile, every
  attribute Google offers the location with its current value, recent posts,
  the food menu, and which fields have edits pending Google's review.
- `search_google_business_profile_categories`: category IDs by name, for
  example "Hamburgues" for `categories/gcid:hamburger_restaurant`.
- `update_google_business_profile_listing`: categories, description, regular,
  holiday and service hours, website and phone numbers.
- `update_google_business_profile_attributes`: yes/no features, single-choice
  values and links such as `url_menu`, `url_order_ahead` and
  `url_reservations`.
- `reply_to_google_business_profile_review`: post, replace or delete your reply
  to a review.
- `create_google_business_profile_post`: publish an update, event or offer,
  with an optional button and photo.
- `update_google_business_profile_food_menu`: change, add or remove menu items.

## How edits work

- Every edit tool previews first. Called without `apply`, it reads the current
  values and returns each field's current and proposed value. Nothing changes
  on Google.
- For categories, description, hours, website and phone numbers, Google
  validates the preview without saving it, so a rejected value shows up before
  you approve anything. Attributes, replies, posts and menu items are checked
  against what Google allows for the listing; Google only fully checks them
  when the change is applied.
- The agent applies a change only after you approve that exact preview in
  chat. Changes go live on Google Search and Maps right away, or after Google
  reviews them. `get_google_business_profile_listing` lists fields with edits
  still pending review.
- Every applied change returns the values it replaced, so the agent can
  preview and apply the undo. Published posts are the exception: delete those
  in Business Profile.
- When the project's website matches one of the account's locations, the edit
  tools change only that location. Edit another brand's listing from its own
  project.
- The business name, address, open or closed status, photos and services are
  not editable here. Change them in Business Profile.
- The connected Google account must be an owner or manager of the listing.

## What OpenSEO stores

Google's Business Profile API policies limit how long its content may be kept.
OpenSEO stores only the selected account's name and ID, which Google account
connected it, and the encrypted OAuth tokens. Reviews, metrics and search terms
are fetched when a tool runs and are never saved. Each tool response asks the
agent to keep that content out of saved reports and project context. Edits go
straight to Google; OpenSEO keeps no copy.

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

**"Google rejected the request: STALE_DATA"**: Google recently changed that
field itself. Review the value in Business Profile; only the owner can accept
or override it there.

**"Google rejected the request: PROFILE_DESCRIPTION_CONTAINS_URL" or
`STRING_TOO_LONG`**: the description has a link or is over 750 characters.
Shorten it and preview again.

**A post shows `REJECTED`**: Google refused it after publishing, often for a
phone number in the text or an image it could not download. Use the call
button instead of a number, and a public image URL.

**The food menu is not editable**: Google allows menus only for some
categories, and `get_google_business_profile_listing` reports
`canHaveFoodMenus: false`. Link a menu page with the `url_menu` attribute
instead.
