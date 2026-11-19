# RanchCord

A private, Discord-style chat app for you and your friends: groups with text and voice channels, DMs, calls with
camera and screen share, a soundboard, roles, GIFs and stickers from KLIPY, photo emojis, and every "Nitro" perk for free.
You host it yourself, so it's just your group, with no ads and no content filter.

- **Windows app** (Rust + WebView2, 2 MB installer, updates itself)
- **Android app** (APK)
- **iPhone** (sideloaded IPA, or "Add to Home Screen" from Safari)
- **Any browser**

## What you need

| Thing | What for | Cost |
| --- | --- | --- |
| A Raspberry Pi 4 (or any always-on PC) | runs the server | you have one |
| A free [DuckDNS](https://www.duckdns.org) address | the address friends type in | free |
| A free [KLIPY](https://partner.klipy.com) key | GIFs and stickers | free |
| Each friend's own storage bucket | pictures, videos and files they send | free up to 10 GB each |

## 1. Run the server on a Raspberry Pi

1. Flash **Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager. In its settings, turn on SSH and set a username and password.
2. Make a free address at [duckdns.org](https://www.duckdns.org) (for example `myranch.duckdns.org`) and keep the token it shows you.
3. SSH into the Pi (`ssh yourname@raspberrypi.local`) and run:

   ```bash
   sudo apt-get install -y git
   git clone https://github.com/KingCreeper531/RanchCord.git ~/ranchcord
   bash ~/ranchcord/deploy/pi/setup.sh
   ```

   It asks for your DuckDNS address and token, your KLIPY key (optional), and an optional signup code, then installs
   everything, turns on HTTPS, starts RanchCord whenever the Pi boots, and checks GitHub for updates every night.
4. On your router, **forward ports 80 and 443** (TCP) to the Pi.
5. Open `https://myranch.duckdns.org`. **The first account made becomes the admin.**

**Hosting behind CGNAT:** if port forwarding doesn't work because your router's WAN address differs from your public address
(often a `100.x.x.x` address), use a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
or [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) pointed at `http://localhost:6420` instead of ports 80/443.

Useful commands on the Pi:

```bash
sudo systemctl status ranchcord        # is it running?
journalctl -u ranchcord -f             # live log
bash ~/ranchcord/deploy/pi/update.sh   # update right now
```

## 2. Server settings

They live in `~/ranchcord/server/.env` on the Pi. Change a line, then run `sudo systemctl restart ranchcord`.

| Setting | What it does |
| --- | --- |
| `KLIPY_API_KEY` | turns on GIFs and stickers |
| `KLIPY_CONTENT_FILTER` | `off` (the default), `low`, `medium` or `high` |
| `MAX_UPLOAD_MB` | biggest file someone can send (**50** by default) |
| `SIGNUP_CODE` | a code friends must type to make an account (empty: anyone with the address can join) |
| `SHRINK_AFTER_DAYS` | after this many days (**30** by default, `0` turns it off), photos become small WebP images and videos and audio are re-encoded to a fraction of the size. Old messages keep working |
| `SHRINK_LEVEL` | how hard to shrink: `gentle`, `strong` (the default) or `extreme` |
| `STORAGE=s3` with `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | keeps profile pictures, emojis and sounds in a cloud bucket instead of on the SD card |

Everyone can give the app their own name and icon in **Settings → Appearance**. It only changes it for them, on that device.

## 3. Everyone links their own storage (to send files)

Pictures, videos and files you send go **straight from your device into your own storage bucket**, not through the server.
Until you link one you can chat, call and use GIFs, but not send files. In the app: **Settings → My Storage**.

**Backblaze B2** (10 GB free, no card needed)

1. Make an account at [backblaze.com](https://www.backblaze.com/cloud-storage) (B2 Cloud Storage).
2. **Buckets → Create a Bucket**: pick a unique name, keep it **Private**. Its page shows the **Endpoint**
   (like `s3.us-west-004.backblazeb2.com`).
3. **Application Keys → Add a New Application Key**: allow access to just that bucket, **Read and Write**.
4. In RanchCord, choose Backblaze B2 and paste the endpoint (with `https://`), bucket name, **keyID** and **applicationKey**.

**Cloudflare R2** (10 GB free, Cloudflare asks for a card)

1. Cloudflare dashboard → **R2** → create a bucket.
2. **Manage API tokens → Create API token** with **Object Read & Write** for just that bucket.
3. In RanchCord, choose Cloudflare R2 and paste the S3 endpoint, bucket name, Access Key ID and Secret Access Key.

Press **Test & link**. RanchCord tries to set up the bucket's upload rule (CORS) for you; if your key isn't allowed to,
it shows the exact rule to paste into the bucket's CORS settings.

Your secret key is stored encrypted on the server, which uses it only to give your friends links to your files.
Unlinking stops new uploads; files you already sent keep showing.

## 4. Get the apps

In RanchCord click the download icon (or **Settings → App & Connection → Get the apps**). The Pi keeps the newest
installers from the latest GitHub release.

- **Windows**: run `RanchCord-Setup.exe`, type your server address. It lives in the tray, can start with Windows, and updates itself.
- **Android**: download `RanchCord.apk` on the phone and allow installing from your browser when asked.
- **iPhone**: install `RanchCord.ipa` with [Sideloadly](https://sideloadly.io) or [AltStore](https://altstore.io) (free Apple
  IDs need re-signing every 7 days), or open your server in Safari → Share → **Add to Home Screen**.

## 5. Releasing an update

```bash
npm run release 1.2.0
```

This sets the version everywhere, tags it and pushes. GitHub then builds the Windows, Android and iPhone apps and
publishes them; Windows apps update themselves, and the Pi updates the server and installers overnight.

One-time setup on GitHub (**Settings → Secrets and variables → Actions**):

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `secrets/tauri-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | empty |
| `ANDROID_KEYSTORE_BASE64` | `client/android/ranchcord-release.jks`, base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | from `client/android/keystore.properties` |

## Back these up (and never upload them anywhere public)

- `secrets/tauri-updater.key`: without it, installed Windows apps can't be updated anymore.
- `client/android/ranchcord-release.jks` and `keystore.properties`: without them, Android updates won't install over the old app.
- On the Pi, `~/ranchcord/server/data/` (the database and `secret.key`, which unlocks everyone's storage keys) and `server/.env`.

## Working on RanchCord on your PC

Needs [Node.js 24](https://nodejs.org). For the Windows app also [Rust](https://rustup.rs); for Android, Android Studio.

```bash
npm run setup          # install everything
npm run dev            # server + web app with live reload: http://localhost:5173
npm run build          # build the web app
npm start              # run the server: http://localhost:6420
npm run desktop        # run the Windows app
npm run desktop:build  # build the Windows installer
npm run android:build  # build downloads/RanchCord.apk
npm run icons          # regenerate every icon from assets/logo-source.webp
```

Server settings live in `server/.env` (see `deploy/pi/setup.sh` for the common ones). Optional extras:
`LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` route big calls through a LiveKit media server, and
`TURN_URL`/`TURN_USERNAME`/`TURN_CREDENTIAL` add a TURN relay for friends on strict networks.

## Credits

- Emoji graphics: [Twemoji](https://github.com/jdecked/twemoji) by Twitter and contributors, [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- GIFs and stickers: [KLIPY](https://klipy.com)
- Icons: [Phosphor](https://phosphoricons.com) (MIT). Fonts: Figtree, Fredoka, JetBrains Mono (SIL OFL)
