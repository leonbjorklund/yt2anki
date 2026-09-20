# Privacy

Updated September 19, 2026. Support/privacy contact: [leon.bjorklund@gmail.com](mailto:leon.bjorklund@gmail.com).

## On your device

After your toolbar action, yt2anki reads video/track details and retrieves selected captions. Drafts, edits, merge history, Pinyin, timing, video/tab references, selections, preferences, deck reservations, and recovery records stay in Chrome's local storage without sync. Pinyin and exports are generated locally. Drafts and exports are unencrypted.

Regeneration replaces that video's Draft; export keeps it. Caption caches end on navigation/close. Recovery records expire after 60 seconds but may remain stored. Uninstalling clears extension storage; delete downloads and Anki data separately.

Packages contain text, video IDs, timing, and formatting, not media. Opening uses only the current download; its URL and pending action stay in memory. yt2anki stores no download paths, searches no general download history, and reads no installed Anki collection.

## YouTube

HTTPS caption requests omit cookies but send video/language/client details and an available visitor identifier. Drafts/caches retain no visitor identifiers or signed URLs.

Embedded players send IP/browser/video information on loading and interactions during playback. Anki cards request autoplay. YouTube may use signed-in cookies; yt2anki cannot read them or account credentials. Preview Referer headers identify the extension. [Google's privacy policy](https://policies.google.com/privacy) applies.

## Maintainer

No developer server, accounts, analytics, advertising, or Draft uploads. Data is used only for these features and support, never sold or used for credit decisions or unrelated purposes.

Support email supplies your address, message, and attachments. Request deletion by email; unresolved security issues or legal obligations may require retention.
