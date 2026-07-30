# yt2anki

Chrome and Edge extension for Windows 11 that creates editable Anki listening cards from manually captioned YouTube videos. Export through AnkiConnect or `.apkg`.

A creator-provided Target Language caption track is required. A Gemini key is needed only when Native Language captions are unavailable.

## Development

Requires Node.js 24+, pnpm 11.6, Anki Desktop 25.09.5+, and [AnkiConnect](https://ankiweb.net/shared/info/2055492159).

```powershell
pnpm install --frozen-lockfile
pnpm build
```

Load `dist` as an unpacked extension. Keep Anki open when exporting.

```powershell
pnpm verify
pnpm audit --prod
```

## License

[MIT](LICENSE)
