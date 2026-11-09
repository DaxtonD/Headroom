# Deploying Headroom

> **Status: the first-run path is written and walked; the rest of the Unraid
> guide is M6.** Everything here has been run, except the two steps marked
> **on Unraid**, which touch a machine this checkout cannot reach.

## Contents

- [First run with real data, on Unraid](#first-run-with-real-data-on-unraid)
- [Development over HTTPS, through Nginx Proxy Manager](#development-over-https-through-nginx-proxy-manager)
- [The two settings that must agree](#the-two-settings-that-must-agree)
- [Server-Sent Events through a proxy](#server-sent-events-through-a-proxy)
- [Before trusting it with real money](#before-trusting-it-with-real-money)

---

## First run with real data, on Unraid

For adding Headroom through **Unraid's Docker Manager**: pull the image, type
the environment variables into the GUI, and never put real values in a file
that could reach git.

Everything below has been run except the steps marked **on Unraid**. The
variable list was checked by starting the image with nothing but those three
set; the account commands were run against that container.

### 0. Prove the backup first, not afterwards

Entering a household's finances takes an evening. Do this from the machine that
has this repo, Node and Docker, with `DATABASE_URL` pointing at the Postgres
you are about to use:

```bash
node scripts/backup.mjs dump
node scripts/backup.mjs verify "backups/headroom-<the file it wrote>.dump"
```

`verify` restores the dump into a throwaway database, counts the rows and drops
it. Until it prints "Verified", there is no backup, only a file. Dumps land in
`backups/`, which is git-ignored because they hold the real figures.

### 1. Create the database (on Unraid)

`prisma migrate deploy` creates tables, never the database, so the container
will wait forever if it is missing:

```sql
CREATE DATABASE headroom;
```

The user in `DATABASE_URL` needs rights to create tables, types and triggers.
The tables themselves are made for you: the entrypoint migrates on every start,
so a first run against an empty database is expected and correct.

### 2. Add the container (on Unraid)

Repository: `ghcr.io/daxtond/headroom:latest`.

| Setting | Value |
|---|---|
| Network | `bridge` |
| Port | container `3000` → whichever host port the proxy will point at |
| Restart policy | `unless-stopped` |

**Only three environment variables have no default.** The image bakes in
`NODE_ENV`, `TZ`, `PORT`, `HOST` and `WEB_DIST_DIR`, so leave those alone:

| Variable | What to put |
|---|---|
| `APP_ORIGIN` | The exact HTTPS address you open the app at, e.g. `https://headroom.example.com`. Cookies and CORS are checked against it, so a mismatch shows up as a login that appears to work and then forgets you. |
| `DATABASE_URL` | `postgresql://user:password@192.168.1.50:5432/headroom?schema=public` |
| `SESSION_SECRET` | `openssl rand -hex 32` |

Worth setting as well, though each has a sensible default:

| Variable | Default | When to change it |
|---|---|---|
| `COOKIE_SECURE` | `true` | Leave it. Only `false` for plain http, which real data should never use. |
| `LOG_LEVEL` | `info` | `debug` while something is wrong. |
| `SESSION_TTL_DAYS` | `90` | Shorter if you would rather sign in more often. |

The app refuses to start on a missing value, or on one still reading
`change-me`, so a half-filled form fails loudly instead of running insecurely.

`.env` is only used by `docker compose`. Typing the values into the Docker
Manager instead keeps them out of any file in this repo, which is the point.

### 3. Watch it come up

In the container's log:

```
Headroom: waiting for the database...
All migrations have been successfully applied.
Headroom is listening
```

If it waits for the database forever, `DATABASE_URL` is wrong, the database
does not exist, or Unraid cannot reach that host. The first pull is around
1.3 GB, nearly all of it Prisma's query engine.

### 4. Create the two accounts

From Unraid's terminal:

```bash
docker exec -it headroom node apps/api/dist/cli.js create-user
docker exec -it headroom node apps/api/dist/cli.js create-user
docker exec -it headroom node apps/api/dist/cli.js list-users
```

The first creates the household; the second joins it. The password is prompted
and never echoed. (`--password-stdin` reads it from a pipe instead, for a
script.)

### 5. Point the proxy at it

See the Nginx Proxy Manager section below, including the two settings that must
agree and the Server-Sent Events headers. Then open `APP_ORIGIN` and sign in.

### 6. Enter the data, in this order

Each step unlocks the next. On **Manage**:

1. **Accounts → Add a chequing account.** Nothing works before this: it is
   where the balance lives, and the checklist at the top of the screen says so.
2. **Paydays**, one per person. Any real payday; the rest are worked out from
   it. Everything dated depends on these.
3. **Income**, the stated monthly and yearly figures. They need not agree with
   each other.
4. **Expenses.** Monthly on a date, monthly on the last day, every two weeks on
   its own dates, a few days after a payday, or flexible. The mortgage goes
   here as an expense *and* under Savings as terms: the first puts it on the
   ledger, the second drives the payoff projection.
5. **Budget-only categories** for spending with no due date: groceries, gas.
6. **Bring upcoming up to date**, which creates the dated items from step 4.

Then **Ledger → Update balance**, and on **Savings**: add a savings account,
enter its balance, add earmarks, then the mortgage terms and any lump sums.

### 7. Back it up again

```bash
node scripts/backup.mjs dump
node scripts/backup.mjs verify "backups/<the new file>.dump"
```

The evening's typing now exists in two places. `restore <file> --yes` puts it
back, and prints what it would overwrite if you leave `--yes` off.

---

## Development over HTTPS, through Nginx Proxy Manager

Service workers, the install prompt and Web Push only work in a **secure
context**. Browsers grant that to `https://` anywhere, and to `http://` only on
`localhost` — never on a LAN IP. So testing the app on a phone over
`http://192.168.x.x` works for the ordinary screens, but the PWA parts need
real HTTPS.

Running the app on the development machine behind an existing reverse proxy:

### 1. Start the app, published on every interface

```
node scripts/testdb.mjs up          # the throwaway database
node scripts/demo.mjs up --origin https://dev.headroom.example.com
```

`scripts/demo.mjs` derives `COOKIE_SECURE` from the origin's scheme, so the two
cannot disagree. It publishes on `0.0.0.0:8484`, which is what lets the proxy
reach it.

### 2. Point a proxy host at it

In Nginx Proxy Manager, add a Proxy Host:

| Field | Value |
|---|---|
| Domain Names | `dev.headroom.example.com` |
| Scheme | `http` |
| Forward Hostname / IP | the development machine's LAN address |
| Forward Port | `8484` |
| Websockets Support | not needed — the live updates use SSE, not websockets |
| Block Common Exploits | on |
| SSL | request a certificate, and turn on **Force SSL** and **HTTP/2** |

If the DNS record is proxied through Cloudflare, use a DNS-01 challenge for the
certificate so no port has to be opened to the internet.

### 3. Check it

```
curl -s https://dev.headroom.example.com/api/health
```

A `{"status":"ok","database":"up",...}` means the whole path works. Then open
the domain on the phone and sign in.

### If the phone cannot reach the app at all

Work through these in order; each rules out a layer.

1. **Is the phone on the same subnet?** Check its IP in wifi settings. A guest
   network, or a mesh node handing out a different range, will not reach
   `192.168.2.x`.
2. **Is the wifi isolating clients?** Many routers have "AP isolation",
   "client isolation" or "guest mode" switched on, which blocks phone-to-PC
   traffic entirely while leaving internet access working. This is the most
   common cause, and a wired proxy (an Unraid box, say) is unaffected by it —
   which is why the proxy route can work when direct access does not.
3. **Is a VPN client on the development machine filtering LAN traffic?**
   A WireGuard or OpenVPN "kill switch" installs WFP filters that drop
   untunnelled traffic. These are invisible in the Windows Firewall UI and stay
   active even with all firewall profiles turned off. Disconnect the VPN and
   retest.
4. **Is Windows Firewall blocking the port?** Only after the above:
   `Get-NetFirewallProfile | Select Name, Enabled`. Connecting to the
   machine's own LAN IP from that same machine bypasses the firewall, so
   "it works locally" proves nothing here.
5. **Is the app actually published externally?**
   `docker ps` should show `0.0.0.0:8484->3000/tcp`. A `127.0.0.1:8484->3000/tcp`
   is reachable only from that machine.

---

## The two settings that must agree

`APP_ORIGIN` and `COOKIE_SECURE` have to match the address the browser really
uses. The failure is quiet and confusing if they do not:

| Address in the browser | `APP_ORIGIN` | `COOKIE_SECURE` |
|---|---|---|
| `http://localhost:8484` | same | `false` |
| `http://192.168.2.105:8484` | same | `false` |
| `https://dev.headroom.example.com` | same | `true` |

A `Secure` cookie is **never sent over plain http**, so `COOKIE_SECURE=true`
with an `http://` origin produces a login that appears to succeed and then
immediately forgets you. The app refuses that combination at startup rather
than letting it happen, and refuses plain http altogether when
`NODE_ENV=production`.

---

## Server-Sent Events through a proxy

The live updates that make one phone reflect the other's change use SSE on
`/api/events`. Two things matter through a proxy, and both are already handled:

- **Buffering.** The response carries `X-Accel-Buffering: no`, which nginx and
  Nginx Proxy Manager honour, so no extra configuration is needed. A proxy that
  buffers would hold pings back until the buffer filled.
- **Idle timeouts.** The stream sends a keep-alive comment every
  `SSE_HEARTBEAT_SECONDS` (25 by default), comfortably inside nginx's 60-second
  `proxy_read_timeout` and Cloudflare's idle limit.

If live updates stop arriving while the rest of the app works, the proxy is
buffering or timing out the stream. The app degrades gracefully: it still
refetches when the app is reopened, focused or reconnects.

---

## Before trusting it with real money

The brief is deliberate about this (HANDOFF section 11): **default to not
publishing this to the internet.** It is the household's complete financial
position, and a public hostname means the login is the only thing between it
and the world.

For development, with invented amounts in a throwaway database, a `dev.`
hostname is a reasonable trade. Before the real figures go in:

- prefer **Tailscale** or another VPN, so the app is not publicly resolvable
  at all;
- or, if it must be public, keep it behind the reverse proxy with HTTPS forced,
  and consider an access layer in front of it — Cloudflare Access, or
  basic auth at the proxy — in addition to the app's own login;
- the app rate-limits **failed** sign-ins per address, which stops password
  guessing but is not a substitute for not being reachable;
- never point a development container at the real database. `scripts/demo.mjs`
  uses a throwaway one on purpose.
