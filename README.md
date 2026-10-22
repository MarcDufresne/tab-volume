# Tab Volume

A small Brave (Chromium) extension that sets a tab's volume from 0 to 100% and remembers it per site. A saved site plays at its level from the first sound, with no clicks. Every Reel on Facebook stays at 6%.

## Install

1. Unzip `tab-volume-1.0.0.zip` into a folder you'll keep. Brave loads the extension from that folder every time it starts.
2. Go to `brave://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the folder.
3. Pin Tab Volume from the puzzle-piece menu.

## Use

- Open the popup on any tab. Move the slider or type an exact value: this changes only that tab.
- Tick **Remember for <site>** to save the level for the whole site, subdomains included. Every tab of that site, open or future, follows it, and changing the slider updates the saved level.
- The badge on the icon shows the tab's level when it's below 100.
- **Saved sites** lists every saved site. Edit a level there, or forget a site with ×.

## Import from Volume Master

1. In `brave://extensions`, with Developer mode on, find Volume Master and click **service worker** next to "Inspect views".
2. In the Console tab, run:

   ```js
   chrome.storage.local.get("domains-settings").then((r) => copy(JSON.stringify(r["domains-settings"] || {})))
   ```

3. Open Tab Volume's popup, expand **Import**, paste, and click **Import**.

## How it works

A script runs in each page before the site's own code. It scales the volume of every `<audio>`/`<video>` element, and of Web Audio output, by the tab's level. The site still sees its own volume values, so its controls don't fight back. Sites with a saved level start silent until the level loads, a few milliseconds, so they're never loud even briefly.

## Development

```bash
npm install
npm test
npm run package
```

The tests drive the installed Brave (`/Applications/Brave Browser.app`). Set `BROWSER_PATH` to use another Chromium. `npm run package` writes `dist/tab-volume-<version>.zip`.
