# Self-hosted Google Analytics

Connecting Google Analytics lets OpenSEO bind a GA4 property to a project. The
connection is optional. OpenSEO reads reports and settings, and changes one
thing: which events count as key events, and only after you approve the change.
See [Key events](#key-events).

## What you'll need

- A Google account with access to the GA4 property.
- A Google Cloud project with OAuth credentials.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `BETTER_AUTH_SECRET` set on
  the OpenSEO deployment.

If Search Console is already connected, reuse the same Google Cloud project and
OAuth client. GA4 still asks for a separate consent grant.

## 1) Enable the Analytics APIs

In the [Google Cloud Console](https://console.cloud.google.com/), enable both:

- [Google Analytics Admin API](https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com)
- [Google Analytics Data API](https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com)

The Admin API lists properties during connection. The Data API powers the
read-only reports added in later GA4 milestones.

## 2) Configure the OAuth consent screen

Under **APIs & Services → OAuth consent screen**, configure the app. While the
app is in Testing, add every Google account that will connect as a test user.

## 3) Register the callback URL

Open **APIs & Services → Credentials**, edit the Web application OAuth client,
and add an authorized redirect URI matching the deployment origin plus
`/api/ga4/oauth/callback`.

| Deployment   | Redirect URI                                             |
| ------------ | -------------------------------------------------------- |
| Deployed     | `https://your-openseo-domain.com/api/ga4/oauth/callback` |
| Local Docker | `http://localhost:3001/api/ga4/oauth/callback`           |

Keep the existing `/api/gsc/oauth/callback` URI if Search Console uses the same
client.

## 4) Set environment variables

Set these values and restart OpenSEO:

| Variable               | Value                                                     |
| ---------------------- | --------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`     | Web application client ID.                                |
| `GOOGLE_CLIENT_SECRET` | Web application client secret.                            |
| `BETTER_AUTH_SECRET`   | Random string of at least 32 characters for token crypto. |

Generate the encryption secret with:

```sh
openssl rand -base64 32
```

## 5) Connect a property

Open a project dashboard or **Project settings → Analytics**, click **Connect
with Google**, approve access, and choose a GA4 property. Google asks for two
Analytics permissions: see your data, and edit your Analytics configuration.
The second one is what lets an agent mark key events.

OpenSEO stores the OAuth tokens encrypted in Better Auth's account table. The
project mapping stores only the selected property metadata and connector
account. Disconnecting GA4 does not disconnect Search Console.

## Key events

The MCP tool `update_google_analytics_key_event` marks an event of the
connected property as a key event, or removes the mark.

- It previews first. Called without `apply`, it reads the current key events
  and returns what would change. Nothing is saved.
- The agent applies the change only after you approve that exact preview in
  the conversation. The response includes the arguments that undo it.
- A new key event is not retroactive: Google Analytics counts it from the
  moment it is marked. Removing a mark deletes no data.
- The connected Google account needs the Editor role on the property.

A connection made before this tool existed is read-only, and the preview says
so. To upgrade it, click **Change property or account** on the Google
Analytics card, open the property list, click **Add Google account**, choose
the same account and approve the new permission. Then cancel: the project
keeps its property.

## Troubleshooting

**`redirect_uri_mismatch`** — make sure the registered URI exactly matches the
scheme, host, port, and `/api/ga4/oauth/callback` path used by the deployment.

**No properties appear** — confirm that the Analytics Admin API is enabled and
the connected Google account has access to the property.

**Connection expired** — reconnect the Google account. OAuth apps left in
Google's Testing status can receive short-lived refresh grants.
