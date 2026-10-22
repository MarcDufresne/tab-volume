# Manual test in Brave

Run this on the computer where the extension will be used.

## Install with tabs already open

1. Open facebook.com in a tab before installing.
2. Unzip `tab-volume-1.0.0.zip` into a folder you'll keep, for example `~/Extensions/tab-volume`.
3. Go to `brave://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick that folder.
4. Pin Tab Volume to the toolbar from the puzzle-piece menu.

## Facebook at 6%

- [ ] On the Facebook tab you opened before installing, open the popup. The site shows `facebook.com`, with no "reload" message.
- [ ] Type `6` in the number box. Playing audio drops at once, and the toolbar badge shows `6`.
- [ ] Tick **Remember for facebook.com**. `facebook.com 6` appears under Saved sites.
- [ ] Scroll through at least 10 Reels. None of them is ever loud, even for a moment.
- [ ] Use Facebook's own volume control on a Reel, then scroll to the next one. It stays quiet.
- [ ] Close every Facebook tab, then open facebook.com again and play a Reel. It's at 6% from the first sound.
- [ ] Open a second Facebook tab and change the level to 10 in the popup. Both tabs follow.

## Other sites

- [ ] YouTube (nothing saved) plays at normal volume and has no badge.
- [ ] On YouTube, set 30 without ticking Remember. Only that tab changes. Close it, reopen YouTube: back to normal.
- [ ] A news article with an embedded YouTube video follows the article site's setting.
- [ ] `brave://settings` popup says "Tab Volume can't control this page." and the controls are disabled.

## Saved sites and import

- [ ] Change a level in the Saved sites list. Open tabs of that site follow.
- [ ] Remove a site with ×. Its tabs go back to normal volume and the badge disappears.
- [ ] Import your Volume Master settings (see README) and check they appear in Saved sites.

## Untick Remember

- [ ] On Facebook, untick Remember. The tab goes back to 100% and the badge disappears.
