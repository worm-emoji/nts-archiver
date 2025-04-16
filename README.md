# NTS Archiver

NTS Archiver is a command-line tool designed to archive episodes from NTS Radio shows. It fetches metadata, downloads episodes, and tags them with relevant information such as tracklists, artwork, and more.

## Requirements

This project has only been tested on macOS. The following dependencies are required:

- [Bun](https://bun.sh/)
- [FFmpeg](https://ffmpeg.org/)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)

## Installation

To install the required dependencies, you can use Homebrew:

```bash
brew install bun ffmpeg yt-dlp
```

Clone this repository and install JS dependencies:

```bash
git clone https://github.com/worm-emoji/nts-archiver
cd nts-archiver
bun install
```

## Usage

Run the archiver with a show slug, show URL, or episode URL:

```bash
bun run index.ts <show-slug | show-url | episode-url> [options]
```

### Examples

```bash
# Download all episodes from Malibu's show
bun run index.ts malibu

# Download with verbose output
bun run index.ts malibu --verbose

# Download with 5 concurrent downloads
bun run index.ts malibu -c 5

# Download using the show URL
bun run index.ts https://www.nts.live/shows/malibu

# Download a single episode
bun run index.ts https://www.nts.live/shows/guests/episodes/oklou-choke-soundscape-15th-april-2025
```

### Arguments

- `<show-slug>`: The slug of the NTS show (e.g., `malibu`)
- `<show-url>`: The full URL to the NTS show (e.g., `https://www.nts.live/shows/malibu`)
- `<episode-url>`: The full URL to a specific NTS episode (e.g., `https://www.nts.live/shows/whities-w-tasker/episodes/whities-w-tasker-13th-april-2025`)

### Options

- `-v, --verbose`: Show detailed command output including download progress
- `-c, --concurrency <num>`: Set number of concurrent downloads (default: 3)

## SoundCloud integration

For downloading from SoundCloud sources, you can set the `SOUNDCLOUD_API_KEY` environment variable. If you have a SoundCloud Go+ account, this results in significantly higher download quality. [Here's how to find the API KEY.](https://www.reddit.com/r/youtubedl/wiki/howdoidownloadhighqualityaudiofromsoundcloud/)

```bash
export SOUNDCLOUD_API_KEY="your-api-key-here"
bun run index.ts <show-slug>
```

## Output

The downloaded episodes will be saved in a directory named after the show slug. Each episode will be properly tagged with:

- Title
- Artist
- Album
- Artwork
- Tracklist (when available)
- Broadcast date
- NTS show URL
