import type {
  NTSApiResponse,
  Episode,
  ShowResponse,
  AudioSource,
} from "./types/nts";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";
import chalk from "chalk";
import ora from "ora";
import cliProgress from "cli-progress";
import boxen from "boxen";
import figlet from "figlet";
import { $ } from "bun";

const execAsync = promisify(exec);

// CLI options
interface CliOptions {
  verbose: boolean;
  concurrency: number;
}

// Track downloaded episodes in a JSON file
interface DownloadedEpisode {
  episode_alias: string;
  broadcast: string;
  filepath: string;
  downloaded_at: string;
  command?: string; // Store the successful yt-dlp command used
}

// Interface for the track in the tracklist
interface Track {
  title: string;
  offset: number | null;
  mainArtists: { name: string; role: string }[];
  featuringArtists: { name: string; role: string }[];
  remixArtists: { name: string; role: string }[];
}

// Interface for the episode metadata response
interface EpisodeMetadataResponse {
  tracklist?: Track[];
  [key: string]: any;
}

// Function to format seconds to MM:SS
function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes.toString().padStart(2, "0")}:${remainingSeconds
    .toString()
    .padStart(2, "0")}`;
}

// Function to fetch episode metadata including tracklist
async function fetchEpisodeMetadata(episode: Episode): Promise<string | null> {
  try {
    // Use episode_alias and show_alias to construct the URL
    const url = `https://www.nts.live/shows/${episode.show_alias}/episodes/${episode.episode_alias}`;

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      console.error(
        `Failed to fetch episode metadata: ${response.status} ${response.statusText}`
      );
      return null;
    }

    const data = (await response.json()) as EpisodeMetadataResponse;

    if (!data.tracklist || data.tracklist.length === 0) {
      console.log("No tracklist found for this episode");
      return null;
    }

    // Check if any track has a timestamp
    const hasAnyTimestamp = data.tracklist.some(
      (track) => track.offset !== null
    );

    // Format the tracklist
    let formattedTracklist = "";
    for (const track of data.tracklist) {
      const artists = track.mainArtists
        .map((artist: { name: string }) => artist.name)
        .join(", ");

      // Add featuring artists if any
      const featuring = track.featuringArtists
        .map((artist: { name: string }) => artist.name)
        .join(", ");
      const featText = featuring ? ` feat. ${featuring}` : "";

      // Add remix artists if any
      const remixers = track.remixArtists
        .map((artist: { name: string }) => artist.name)
        .join(", ");
      const remixText = remixers ? ` (${remixers} Remix)` : "";

      // Format with timestamp if offset exists
      // Only add [--:--] placeholder if at least one track has a timestamp
      let timestamp = "";
      if (track.offset) {
        timestamp = `[${formatTime(track.offset)}] `;
      } else if (hasAnyTimestamp) {
        timestamp = "[--:--] ";
      }

      formattedTracklist += `${timestamp}${artists}${featText} — ${track.title}${remixText}\n`;
    }

    return formattedTracklist;
  } catch (error) {
    console.error(`Error fetching episode metadata: ${String(error)}`);
    return null;
  }
}

async function fetchAllEpisodes(slug: string): Promise<Episode[]> {
  const baseUrl = `https://www.nts.live/api/v2/shows/${slug}/episodes`;
  const limit = 12;
  let offset = 0;
  let totalCount = Infinity;
  const allEpisodes: Episode[] = [];

  const spinner = ora(
    `Fetching episodes for show: ${chalk.cyan(slug)}`
  ).start();
  const progressBar = new cliProgress.SingleBar({
    format:
      "Fetching episodes |" +
      chalk.cyan("{bar}") +
      "| {percentage}% | {value}/{total} episodes",
    barCompleteChar: "\u2588",
    barIncompleteChar: "\u2591",
    hideCursor: true,
  });

  try {
    while (offset < totalCount) {
      const url = `${baseUrl}?offset=${offset}&limit=${limit}`;
      spinner.text = `Fetching: ${chalk.cyan(url)}`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(
          `Failed to fetch data: ${response.status} ${response.statusText}`
        );
      }

      const data = (await response.json()) as NTSApiResponse;
      const episodes = data.results || [];
      allEpisodes.push(...episodes);

      totalCount = data.metadata?.resultset?.count || 0;

      // Initialize progress bar on first data
      if (offset === 0) {
        spinner.stop();
        progressBar.start(totalCount, allEpisodes.length);
      } else {
        progressBar.update(allEpisodes.length);
      }

      offset += limit;
    }

    progressBar.stop();
    spinner.succeed(
      `Successfully fetched ${chalk.green(
        allEpisodes.length.toString()
      )} episodes`
    );
    return allEpisodes;
  } catch (error) {
    spinner.fail(
      `Error fetching episodes: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    progressBar.stop();
    throw error;
  }
}

async function fetchShowMetadata(slug: string): Promise<ShowResponse> {
  const url = `https://www.nts.live/shows/${slug}`;
  const spinner = ora(`Fetching show metadata: ${chalk.cyan(url)}`).start();

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch show data: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as ShowResponse;
    spinner.succeed(`Fetched show metadata for: ${chalk.green(data.name)}`);
    return data;
  } catch (error) {
    spinner.fail(
      `Error fetching show metadata: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    throw error;
  }
}

async function checkCommandExists(command: string): Promise<boolean> {
  try {
    await execAsync(`which ${command}`);
    return true;
  } catch (error) {
    return false;
  }
}

function getSafeFilename(name: string): string {
  // Replace unsafe characters with dashes and convert spaces to dashes
  return name
    .replace(/[/\\?%*:|"<>\s]+/g, "-")
    .replace(/--+/g, "-") // Replace multiple dashes with single dash
    .replace(/^-|-$/g, "") // Remove leading/trailing dashes
    .trim();
}

function extractAlbumArtist(title: string): string | null {
  // Try to match either "w/" or "WITH" patterns
  const withSlashMatch = title.match(/w\/\s+(.*?)(?:\s*$)/i);
  const withWordMatch = title.match(/\bWith\s+(.*?)(?:\s*$)/i);

  // Return the first match found
  if (withSlashMatch && withSlashMatch[1]) {
    return withSlashMatch[1].trim();
  } else if (withWordMatch && withWordMatch[1]) {
    return withWordMatch[1].trim();
  }

  return null;
}

function getDownloadRegistry(outputDir: string): DownloadedEpisode[] {
  const registryPath = path.join(outputDir, "download_registry.json");

  if (fs.existsSync(registryPath)) {
    try {
      const data = fs.readFileSync(registryPath, "utf-8");
      return JSON.parse(data) as DownloadedEpisode[];
    } catch (error) {
      console.warn(
        chalk.yellow("Failed to read download registry, creating a new one:"),
        error
      );
      return [];
    }
  }

  return [];
}

function saveDownloadRegistry(
  outputDir: string,
  registry: DownloadedEpisode[]
): void {
  const registryPath = path.join(outputDir, "download_registry.json");
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf-8");
}

function isEpisodeDownloaded(
  registry: DownloadedEpisode[],
  episode: Episode
): boolean {
  return registry.some(
    (entry) => entry.episode_alias === episode.episode_alias
  );
}

// Function to get the best audio source with priority for SoundCloud
function getBestAudioSource(episode: Episode): { url: string; source: string } {
  // Default to undefined - we'll check this later
  let bestSource: { url: string; source: string } | undefined;

  // Always prioritize SoundCloud if available
  if (episode.audio_sources && episode.audio_sources.length > 0) {
    // First look for a SoundCloud source
    const soundcloudSource = episode.audio_sources.find(
      (s) => s.source === "soundcloud"
    );
    if (soundcloudSource && soundcloudSource.url) {
      bestSource = {
        url: soundcloudSource.url,
        source: soundcloudSource.source,
      };
    } else if (episode.audio_sources[0] && episode.audio_sources[0].url) {
      // Otherwise use the first available source
      bestSource = {
        url: episode.audio_sources[0].url,
        source: episode.audio_sources[0].source,
      };
    }
  }

  // If no source found and mixcloud URL exists, use that as fallback
  if (!bestSource && episode.mixcloud) {
    bestSource = { url: episode.mixcloud, source: "mixcloud" };
  }

  // If we still don't have a source, throw an error
  if (!bestSource) {
    throw new Error(`No audio sources found for episode: ${episode.name}`);
  }

  return bestSource;
}

// Function to format date as YYYYMMDD
function formatDateYYYYMMDD(date: Date): string {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}${month}${day}`;
}

// Save to registry with locking to handle concurrency
function saveDownloadRegistrySafe(
  outputDir: string,
  registry: DownloadedEpisode[],
  downloadInfo: DownloadedEpisode
): void {
  const registryPath = path.join(outputDir, "download_registry.json");
  const lockPath = path.join(outputDir, "download_registry.lock");

  // Simple file-based locking with retries
  const acquireLock = (): boolean => {
    try {
      // Check if lock exists and is fresh (< 30 seconds old)
      if (fs.existsSync(lockPath)) {
        const lockStats = fs.statSync(lockPath);
        const lockAge = Date.now() - lockStats.mtimeMs;
        if (lockAge < 30000) {
          // 30 seconds lock timeout
          return false;
        }
        // Lock is stale, we can remove it
        fs.unlinkSync(lockPath);
      }

      // Create lock file
      fs.writeFileSync(lockPath, String(Date.now()));
      return true;
    } catch (error) {
      return false;
    }
  };

  const releaseLock = (): void => {
    try {
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
    } catch (error) {
      // Ignore errors when releasing lock
    }
  };

  // Retry logic for lock acquisition
  let attempts = 0;
  const maxAttempts = 10;
  let delay = 50; // Start with 50ms delay, then exponential backoff

  const tryWithLock = (): void => {
    if (acquireLock()) {
      try {
        // Read current registry
        let currentRegistry: DownloadedEpisode[] = [];
        if (fs.existsSync(registryPath)) {
          try {
            const data = fs.readFileSync(registryPath, "utf-8");
            currentRegistry = JSON.parse(data) as DownloadedEpisode[];
          } catch (error) {
            // If registry is corrupt, start with empty
            currentRegistry = [];
          }
        }

        // Add new entry if not already exists
        if (
          !currentRegistry.some(
            (entry) => entry.episode_alias === downloadInfo.episode_alias
          )
        ) {
          currentRegistry.push(downloadInfo);
        }

        // Write updated registry
        fs.writeFileSync(
          registryPath,
          JSON.stringify(currentRegistry, null, 2),
          "utf-8"
        );

        // Update in-memory registry as well
        registry.length = 0;
        registry.push(...currentRegistry);
      } catch (error) {
        console.error(
          chalk.red(
            `Error updating registry: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
      } finally {
        releaseLock();
      }
    } else {
      // Lock acquisition failed
      attempts++;
      if (attempts < maxAttempts) {
        // Exponential backoff
        setTimeout(() => {
          delay *= 1.5;
          tryWithLock();
        }, delay);
      } else {
        console.error(
          chalk.red(
            `Failed to acquire lock for registry after ${maxAttempts} attempts.`
          )
        );
      }
    }
  };

  tryWithLock();
}

// Execute ffmpeg using spawn instead of exec to avoid path truncation
function spawnFFmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", args);

    let stdoutChunks: Buffer[] = [];
    let stderrChunks: Buffer[] = [];

    ffmpeg.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
    });

    ffmpeg.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
    });

    ffmpeg.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();

      if (code === 0) {
        resolve();
      } else {
        const error = new Error(`FFmpeg exited with code ${code}`);
        // @ts-ignore
        error.stdout = stdout;
        // @ts-ignore
        error.stderr = stderr;
        reject(error);
      }
    });

    ffmpeg.on("error", (err) => {
      reject(err);
    });
  });
}

// Execute ffmpeg using Bun's $ shell
async function runFFmpeg(
  inputFile: string,
  metadata: {
    title: string;
    artist: string;
    albumArtist: string;
    album: string;
    track?: string;
    date: string;
    lyrics?: string;
    comment?: string;
    artworkPath?: string;
  },
  outputFile: string,
  verbose: boolean = false
): Promise<void> {
  try {
    // Handle artwork and verbose options
    if (metadata.artworkPath && fs.existsSync(metadata.artworkPath)) {
      // With artwork
      if (metadata.lyrics) {
        // With artwork and lyrics
        if (verbose) {
          await $`ffmpeg -y -i ${inputFile} -i ${metadata.artworkPath} \
            -map 0:0 -map 1:0 -disposition:v attached_pic \
            -metadata title=${metadata.title} \
            -metadata artist=${metadata.artist} \
            -metadata album=${metadata.album} \
            -metadata album_artist=${metadata.albumArtist} \
            -metadata track=${metadata.track || ""} \
            -metadata date=${metadata.date} \
            -metadata lyrics=${metadata.lyrics} \
            -metadata comment=${metadata.comment || ""} \
            -codec copy ${outputFile}`;
        } else {
          await $`ffmpeg -y -loglevel quiet -i ${inputFile} -i ${
            metadata.artworkPath
          } \
            -map 0:0 -map 1:0 -disposition:v attached_pic \
            -metadata title=${metadata.title} \
            -metadata artist=${metadata.artist} \
            -metadata album=${metadata.album} \
            -metadata album_artist=${metadata.albumArtist} \
            -metadata track=${metadata.track || ""} \
            -metadata date=${metadata.date} \
            -metadata lyrics=${metadata.lyrics} \
            -metadata comment=${metadata.comment || ""} \
            -codec copy ${outputFile}`;
        }
      } else {
        // With artwork but no lyrics
        if (verbose) {
          await $`ffmpeg -y -i ${inputFile} -i ${metadata.artworkPath} \
            -map 0:0 -map 1:0 -disposition:v attached_pic \
            -metadata title=${metadata.title} \
            -metadata artist=${metadata.artist} \
            -metadata album=${metadata.album} \
            -metadata album_artist=${metadata.albumArtist} \
            -metadata track=${metadata.track || ""} \
            -metadata date=${metadata.date} \
            -metadata comment=${metadata.comment || ""} \
            -codec copy ${outputFile}`;
        } else {
          await $`ffmpeg -y -loglevel quiet -i ${inputFile} -i ${
            metadata.artworkPath
          } \
            -map 0:0 -map 1:0 -disposition:v attached_pic \
            -metadata title=${metadata.title} \
            -metadata artist=${metadata.artist} \
            -metadata album=${metadata.album} \
            -metadata album_artist=${metadata.albumArtist} \
            -metadata track=${metadata.track || ""} \
            -metadata date=${metadata.date} \
            -metadata comment=${metadata.comment || ""} \
            -codec copy ${outputFile}`;
        }
      }
    } else {
      // Without artwork
      if (metadata.lyrics) {
        // No artwork but with lyrics
        if (verbose) {
          await $`ffmpeg -y -i ${inputFile} \
            -metadata title=${metadata.title} \
            -metadata artist=${metadata.artist} \
            -metadata album=${metadata.album} \
            -metadata album_artist=${metadata.albumArtist} \
            -metadata track=${metadata.track || ""} \
            -metadata date=${metadata.date} \
            -metadata lyrics=${metadata.lyrics} \
            -metadata comment=${metadata.comment || ""} \
            -codec copy ${outputFile}`;
        } else {
          await $`ffmpeg -y -loglevel quiet -i ${inputFile} \
            -metadata title=${metadata.title} \
            -metadata artist=${metadata.artist} \
            -metadata album=${metadata.album} \
            -metadata album_artist=${metadata.albumArtist} \
            -metadata track=${metadata.track || ""} \
            -metadata date=${metadata.date} \
            -metadata lyrics=${metadata.lyrics} \
            -metadata comment=${metadata.comment || ""} \
            -codec copy ${outputFile}`;
        }
      } else {
        // No artwork and no lyrics
        if (verbose) {
          await $`ffmpeg -y -i ${inputFile} \
            -metadata title=${metadata.title} \
            -metadata artist=${metadata.artist} \
            -metadata album=${metadata.album} \
            -metadata album_artist=${metadata.albumArtist} \
            -metadata track=${metadata.track || ""} \
            -metadata date=${metadata.date} \
            -metadata comment=${metadata.comment || ""} \
            -codec copy ${outputFile}`;
        } else {
          await $`ffmpeg -y -loglevel quiet -i ${inputFile} \
            -metadata title=${metadata.title} \
            -metadata artist=${metadata.artist} \
            -metadata album=${metadata.album} \
            -metadata album_artist=${metadata.albumArtist} \
            -metadata track=${metadata.track || ""} \
            -metadata date=${metadata.date} \
            -metadata comment=${metadata.comment || ""} \
            -codec copy ${outputFile}`;
        }
      }
    }
  } catch (error) {
    // Add stdout and stderr properties to be consistent with the old function
    const err = new Error(`FFmpeg execution failed: ${error}`);
    // @ts-ignore
    err.stdout = "";
    // @ts-ignore
    err.stderr = error.toString();
    throw err;
  }
}

async function downloadEpisode(
  episode: Episode,
  showData: ShowResponse,
  outputDir: string,
  trackNumber: number,
  registry: DownloadedEpisode[],
  progressBar: cliProgress.SingleBar,
  options: CliOptions,
  episodeIndex: number,
  concurrentPosition: number
): Promise<string | null> {
  // Check if episode has already been downloaded
  if (isEpisodeDownloaded(registry, episode)) {
    progressBar.increment(1, {
      status: "SKIPPED",
      name: formatDateYYYYMMDD(new Date(episode.broadcast)),
      concurrent: `${concurrentPosition}/${options.concurrency}`,
    });
    return null;
  }

  // Check if required tools exist
  const ytDlpExists = await checkCommandExists("yt-dlp");
  if (!ytDlpExists) {
    throw new Error("yt-dlp is not installed. Please install it first.");
  }

  const ffmpegExists = await checkCommandExists("ffmpeg");
  if (!ffmpegExists) {
    throw new Error("ffmpeg is not installed. Please install it first.");
  }

  // Create output directory if it doesn't exist
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Get the best audio source with prioritization
  const { source, url } = getBestAudioSource(episode);

  progressBar.update({ status: "DOWNLOADING", name: episode.name, source });

  // Parse date from broadcast field directly
  const broadcastDate = new Date(episode.broadcast);
  const formattedDate = `${broadcastDate.getDate()} ${
    [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ][broadcastDate.getMonth()]
  } ${broadcastDate.getFullYear()}`;
  const year = broadcastDate.getFullYear().toString();

  // Format the date as YYYYMMDD for the filename and display
  const dateForFilename = formatDateYYYYMMDD(broadcastDate);

  // Create a safer filename that includes the show name
  const safeShowName = getSafeFilename(showData.name).toLowerCase();
  const episodeName = dateForFilename;

  // Use system temp directory and UUID for temp files
  const tempId = randomUUID();
  const tempOutputPath = path.join(os.tmpdir(), `nts-dl-${tempId}`);

  // Format final filename with just show name and date
  const finalFilename = `${safeShowName}-${dateForFilename}`;
  const finalOutputPath = path.join(outputDir, finalFilename);

  // Prepare yt-dlp command - use AAC as output format
  let ytDlpCommand = `yt-dlp -x --audio-format aac -o "${tempOutputPath}.%(ext)s" ${
    options.verbose ? "" : "--no-progress"
  }`;

  // Add Soundcloud API key if available and source is soundcloud
  const soundcloudApiKey = process.env.SOUNDCLOUD_API_KEY;
  let ytDlpCommandForRegistry = ytDlpCommand; // Command without API key for registry

  if (soundcloudApiKey && source === "soundcloud") {
    ytDlpCommand += ` -u oauth -p "${soundcloudApiKey}"`;
    ytDlpCommandForRegistry += ` -u oauth -p "API_KEY_REDACTED"`;
  }

  // Format selection based on source
  let formatOption = "";
  if (soundcloudApiKey && source === "soundcloud") {
    formatOption = " -f http_aac_1_0";
  } else if (source === "mixcloud") {
    formatOption = " -f hls-192";
  }

  // Download with format option first, if it fails try without
  let outputFilePath = "";
  let successfulCommand = ""; // Track which command was successful

  const fullCommand = `${ytDlpCommand}${formatOption} "${url}"`;
  const fullCommandForRegistry = `${ytDlpCommandForRegistry}${formatOption} "${url}"`;
  const fallbackCommand = `${ytDlpCommand} "${url}"`;
  const fallbackCommandForRegistry = `${ytDlpCommandForRegistry} "${url}"`;

  // If verbose mode, print commands
  if (options.verbose) {
    console.log(`\n[${episodeIndex}] ${chalk.cyan("Download command:")}`);
    console.log(`[${episodeIndex}] ${chalk.dim(fullCommand)}`);
  }

  // Try to find the downloaded file - Modified for temp directory usage
  let findDownloadedFile = (): string => {
    // The best way to find the file is to look for it in the temp directory
    // with the tempId we generated
    const tempDir = os.tmpdir();
    const files = fs.readdirSync(tempDir);

    // Look for any file starting with our temp ID prefix
    const tempFile = files.find((file) => file.startsWith(`nts-dl-${tempId}`));

    if (tempFile) {
      return path.join(tempDir, tempFile);
    }

    throw new Error("Could not find downloaded file in temp directory");
  };

  try {
    if (formatOption) {
      try {
        progressBar.update({
          status: `DOWNLOADING (${source})`,
          name: episodeName,
          concurrent: `${concurrentPosition}/${options.concurrency}`,
        });
        const { stdout } = await execAsync(fullCommand);
        successfulCommand = fullCommandForRegistry; // Store the successful command for registry

        if (options.verbose) {
          console.log(`\n[${episodeIndex}] ${chalk.dim(stdout)}`);
        }

        // Extract output file from yt-dlp output
        const fileMatch = stdout.match(
          /\[download\] (.*) has already been downloaded/
        );
        if (fileMatch && fileMatch[1]) {
          outputFilePath = fileMatch[1];
        } else {
          // Use our helper function to find the downloaded file
          outputFilePath = findDownloadedFile();
        }
      } catch (error) {
        // Always log yt-dlp errors in verbose mode
        if (options.verbose) {
          console.error(
            `\n[${episodeIndex}] ${chalk.red(
              "Error with format-specific command:"
            )}`
          );
          console.error(`[${episodeIndex}] ${chalk.red(String(error))}`);
        }

        // Keep status as DOWNLOADING even during retry, just add (retry) suffix
        progressBar.update({
          status: `DOWNLOADING (${source}, retry)`,
          name: episodeName,
          concurrent: `${concurrentPosition}/${options.concurrency}`,
        });

        if (options.verbose) {
          console.log(
            `\n[${episodeIndex}] ${chalk.yellow(
              "Retry with fallback command:"
            )}`
          );
          console.log(`[${episodeIndex}] ${chalk.dim(fallbackCommand)}`);
        }

        try {
          const { stdout } = await execAsync(fallbackCommand);
          successfulCommand = fallbackCommandForRegistry; // Store the successful fallback command

          if (options.verbose) {
            console.log(`\n[${episodeIndex}] ${chalk.dim(stdout)}`);
          }

          // Extract the same output file logic here
          const fileMatch = stdout.match(
            /\[download\] (.*) has already been downloaded/
          );
          if (fileMatch && fileMatch[1]) {
            outputFilePath = fileMatch[1];
          } else {
            // Use our helper function to find the downloaded file
            outputFilePath = findDownloadedFile();
          }
        } catch (fallbackError) {
          // Always log fallback errors in verbose mode
          if (options.verbose) {
            console.error(
              `\n[${episodeIndex}] ${chalk.red("Error with fallback command:")}`
            );
            console.error(
              `[${episodeIndex}] ${chalk.red(String(fallbackError))}`
            );
          }
          throw fallbackError; // Re-throw to be caught by the outer catch
        }
      }
    } else {
      progressBar.update({
        status: `DOWNLOADING (${source})`,
        name: episodeName,
        concurrent: `${concurrentPosition}/${options.concurrency}`,
      });

      try {
        const { stdout } = await execAsync(fallbackCommand);
        successfulCommand = fallbackCommandForRegistry; // Store the successful command

        if (options.verbose) {
          console.log(`\n[${episodeIndex}] ${chalk.dim(stdout)}`);
        }

        // Extract the same output file logic here
        const fileMatch = stdout.match(
          /\[download\] (.*) has already been downloaded/
        );
        if (fileMatch && fileMatch[1]) {
          outputFilePath = fileMatch[1];
        } else {
          // Use our helper function to find the downloaded file
          outputFilePath = findDownloadedFile();
        }
      } catch (directError) {
        // Always log direct errors in verbose mode
        if (options.verbose) {
          console.error(
            `\n[${episodeIndex}] ${chalk.red("Error with direct command:")}`
          );
          console.error(`[${episodeIndex}] ${chalk.red(String(directError))}`);
        }
        throw directError; // Re-throw to be caught by the outer catch
      }
    }
  } catch (error) {
    progressBar.update({
      status: `ERROR (${source})`,
      name: episodeName,
      concurrent: `${concurrentPosition}/${options.concurrency}`,
    });

    // Always log all download errors in verbose mode with details
    if (options.verbose) {
      console.error(`\n[${episodeIndex}] ${chalk.red("Download failed:")}`);
      console.error(`[${episodeIndex}] ${chalk.red(String(error))}`);
    }

    throw new Error(`Failed to download audio: ${(error as Error).message}`);
  }

  if (!outputFilePath || !fs.existsSync(outputFilePath)) {
    throw new Error("Could not find downloaded file");
  }

  // Get the file extension
  const fileExt = path.extname(outputFilePath);
  const finalOutputWithExt = `${finalOutputPath}${fileExt}`;

  progressBar.update({
    status: "PROCESSING",
    name: episodeName,
    concurrent: `${concurrentPosition}/${options.concurrency}`,
  });

  // Download artwork - use unique temp file per episode to avoid conflicts
  const artworkUrl = episode.media.picture_large;
  const artworkPath = path.join(os.tmpdir(), `nts-artwork-${tempId}.jpg`);
  try {
    const artworkResponse = await fetch(artworkUrl);
    const artworkBuffer = await artworkResponse.arrayBuffer();
    fs.writeFileSync(artworkPath, Buffer.from(artworkBuffer));
  } catch (error) {
    // Continue without artwork if it fails
  }

  // Prepare metadata
  const title = formattedDate;

  // Extract artist from episode name (after w/)
  const extractedArtist = extractAlbumArtist(episode.name);

  // Get artist from show data
  const showArtist =
    showData.artistsPresent &&
    showData.artistsPresent.length > 0 &&
    showData.artistsPresent[0] &&
    showData.artistsPresent[0].name
      ? showData.artistsPresent[0].name
      : "Unknown Artist";

  // Swap artist and album_artist as per request
  const artist = extractedArtist || showArtist; // Primary artist (was albumArtist)
  const albumArtist = showArtist; // Album artist (was artist)
  const album = showData.name;

  progressBar.update({
    status: "TAGGING",
    name: episodeName,
    concurrent: `${concurrentPosition}/${options.concurrency}`,
  });

  // Prepare ffmpeg command for logging purposes
  let ffmpegCmd = `ffmpeg -y -i "${outputFilePath}"`;

  // Fetch tracklist for lyrics metadata
  let tracklist: string | undefined;
  try {
    const fetchedTracklist = await fetchEpisodeMetadata(episode);
    if (fetchedTracklist) {
      tracklist = fetchedTracklist;

      if (options.verbose) {
        console.log(`\n[${episodeIndex}] ${chalk.cyan("Tracklist found:")}`);
        console.log(`[${episodeIndex}] ${chalk.dim(tracklist)}`);
      }
    }
  } catch (error) {
    console.error(`Error fetching tracklist: ${String(error)}`);
    // Continue without tracklist
  }

  if (fs.existsSync(artworkPath)) {
    ffmpegCmd += ` -i "${artworkPath}" -map 0:0 -map 1:0 -disposition:v attached_pic`;
  }

  ffmpegCmd += ` -metadata title="${title}"`;
  ffmpegCmd += ` -metadata artist="${artist}"`;
  ffmpegCmd += ` -metadata album="${album}"`;
  ffmpegCmd += ` -metadata album_artist="${albumArtist}"`;
  ffmpegCmd += ` -metadata track="${trackNumber}/${showData.episodes.length}"`;
  ffmpegCmd += ` -metadata date="${year}"`;

  if (tracklist) {
    ffmpegCmd += ` -metadata lyrics="${tracklist.replace(/"/g, '\\"')}"`;
  }

  // Add NTS show URL as comment
  const ntsUrl = `https://www.nts.live/shows/${episode.show_alias}/episodes/${episode.episode_alias}`;
  ffmpegCmd += ` -metadata comment="${ntsUrl}"`;

  ffmpegCmd += ` -codec copy "${finalOutputWithExt}"`;

  if (options.verbose) {
    console.log(`\n[${episodeIndex}] ${chalk.cyan("FFmpeg command:")}`);
    console.log(`[${episodeIndex}] ${ffmpegCmd}`);
  }

  try {
    // Use runFFmpeg instead of spawnFFmpeg
    await runFFmpeg(
      outputFilePath,
      {
        title,
        artist,
        albumArtist,
        album,
        track: `${trackNumber}/${showData.episodes.length}`,
        date: year,
        lyrics: tracklist,
        comment: ntsUrl,
        artworkPath,
      },
      finalOutputWithExt,
      options.verbose
    );

    // Clean up temporary files
    if (fs.existsSync(outputFilePath)) {
      fs.unlinkSync(outputFilePath);
    }
    if (fs.existsSync(artworkPath)) {
      fs.unlinkSync(artworkPath);
    }

    // Register the download immediately after it completes
    const downloadInfo: DownloadedEpisode = {
      episode_alias: episode.episode_alias,
      broadcast: episode.broadcast,
      filepath: finalOutputWithExt,
      downloaded_at: new Date().toISOString(),
      command: successfulCommand,
    };

    // Save to registry right after download - handles concurrency safely
    saveDownloadRegistrySafe(outputDir, registry, downloadInfo);

    progressBar.increment(1, {
      status: "COMPLETED",
      name: episodeName,
      concurrent: `${concurrentPosition}/${options.concurrency}`,
    });
    return finalOutputWithExt;
  } catch (error) {
    // Improved error printing for ffmpeg failures
    progressBar.update({
      status: "FFMPEG ERROR",
      name: episodeName,
      concurrent: `${concurrentPosition}/${options.concurrency}`,
    });

    // Always log ffmpeg error details regardless of verbose mode
    console.error(
      `\n${chalk.bgRed.white(" FFMPEG ERROR ")} Episode ${episodeName}`
    );

    if (options.verbose) {
      console.error(`${chalk.yellow("Command:")} ${ffmpegCmd}`);
    }

    console.error(`${chalk.red("Error details:")}`);

    // Get stderr from the error if available
    const stderr = (error as any).stderr || "";
    if (stderr) {
      console.error(chalk.red(stderr));
    } else {
      console.error(chalk.red(String(error)));
    }

    // Additional debugging hints
    console.error(`\n${chalk.blue("Debugging tips:")}`);
    console.error("- Check if ffmpeg is installed and in your PATH");
    console.error("- Check if the input file exists and is valid");
    console.error(
      "- Check if you have write permissions for the output directory"
    );
    console.error("- Try running the command manually to see the full error");

    // Full file paths for debugging
    console.error(`\n${chalk.blue("File paths:")}`);
    console.error(`Input file: ${outputFilePath}`);
    console.error(`Output file: ${finalOutputWithExt}`);
    console.error(`Artwork file: ${artworkPath}`);
    console.error(`Input file exists: ${fs.existsSync(outputFilePath)}`);
    console.error(
      `Output directory exists: ${fs.existsSync(
        path.dirname(finalOutputWithExt)
      )}`
    );

    throw new Error(
      `FFMPEG failed for episode ${episodeName}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

// Function to process episodes in batches with concurrency
async function processEpisodesWithConcurrency(
  episodes: Episode[],
  showData: ShowResponse,
  outputDir: string,
  registry: DownloadedEpisode[],
  progressBar: cliProgress.SingleBar,
  options: CliOptions
): Promise<{ downloaded: number; skipped: number; failed: number }> {
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  let currentIndex = 0;

  // Process episodes in batches based on concurrency
  while (currentIndex < episodes.length) {
    const batch = [];

    // Create a batch of promises up to the concurrency limit
    for (
      let i = 0;
      i < options.concurrency && currentIndex + i < episodes.length;
      i++
    ) {
      const episodeIndex = currentIndex + i;
      const episode = episodes[episodeIndex];
      if (!episode) continue;

      const trackNumber = episodeIndex + 1;
      const concurrentPosition = i + 1; // Position in current batch (1-based)

      batch.push(
        (async () => {
          try {
            const result = await downloadEpisode(
              episode,
              showData,
              outputDir,
              trackNumber,
              registry,
              progressBar,
              options,
              episodeIndex + 1, // 1-based index for display
              concurrentPosition
            );

            if (result) {
              downloaded++;
            } else {
              skipped++;
            }

            return { success: true };
          } catch (error) {
            failed++;
            const episodeName = formatDateYYYYMMDD(new Date(episode.broadcast));
            progressBar.update({
              status: "FAILED",
              name: episodeName,
              concurrent: `${concurrentPosition}/${options.concurrency}`,
            });
            progressBar.increment();

            if (options.verbose) {
              console.error(
                `\n[${episodeIndex + 1}] ${chalk.red("Error:")} ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }

            return { success: false, error };
          }
        })()
      );
    }

    // Wait for all downloads in this batch to complete
    const results = await Promise.all(batch);

    // Enhanced error reporting for this batch
    results.forEach((result, idx) => {
      if (!result.success && result.error) {
        const batchIndex = currentIndex + idx;
        if (batchIndex < episodes.length) {
          const episode = episodes[batchIndex];
          if (episode) {
            const episodeDate = formatDateYYYYMMDD(new Date(episode.broadcast));
            console.error(
              `\n${chalk.bgRed.white(" FAILED ")} Episode ${episodeDate}: ${
                result.error instanceof Error
                  ? result.error.message
                  : String(result.error)
              }`
            );
          }
        }
      }
    });

    // Move to the next batch
    currentIndex += options.concurrency;
  }

  return { downloaded, skipped, failed };
}

// Function to display a fancy ASCII art header
function displayHeader(text: string): void {
  console.log("\n");
  console.log(
    chalk.cyan(figlet.textSync("NTS Archiver", { font: "Standard" }))
  );
  console.log(chalk.dim("─".repeat(process.stdout.columns || 80)));
  console.log(chalk.yellow(text));
  console.log(chalk.dim("─".repeat(process.stdout.columns || 80)));
  console.log("\n");
}

// Function to display a summary box at the end
function displaySummary(stats: {
  downloaded: number;
  skipped: number;
  failed: number;
  showName: string;
}): void {
  const { downloaded, skipped, failed, showName } = stats;
  const total = downloaded + skipped + failed;

  const content = `
${chalk.bold("Download Summary for:")} ${chalk.cyan(showName)}

${chalk.green("✓")} ${chalk.bold("Downloaded:")} ${downloaded} episodes
${chalk.yellow("⏭")} ${chalk.bold("Skipped:")}    ${skipped} episodes
${chalk.red("✗")} ${chalk.bold("Failed:")}     ${failed} episodes
${chalk.dim("─".repeat(40))}
${chalk.bold("Total:")}        ${total} episodes
  `;

  console.log(
    boxen(content, {
      padding: 1,
      margin: 1,
      borderStyle: "round",
      borderColor: "cyan",
      backgroundColor: "#000",
    })
  );
}

// Parse command line arguments
function parseArguments(): {
  slug: string;
  options: CliOptions;
  singleEpisodeUrl: string | null;
} {
  const args = process.argv.slice(2);

  // Default options
  const options: CliOptions = {
    verbose: false,
    concurrency: 3,
  };

  // Extract options
  const nonOptionArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] || "";

    if (arg === "-v" || arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "-c" || arg === "--concurrency") {
      // Get the next argument as the concurrency value
      if (i + 1 < args.length && args[i + 1]) {
        const nextArg = String(args[i + 1]); // Convert to string explicitly
        const concurrencyValue = parseInt(nextArg, 10);
        if (!isNaN(concurrencyValue) && concurrencyValue > 0) {
          options.concurrency = concurrencyValue;
          i++; // Skip the next argument since we consumed it
        } else {
          console.warn(
            chalk.yellow(
              `Invalid concurrency value: ${nextArg}, using default: ${options.concurrency}`
            )
          );
        }
      }
    } else {
      nonOptionArgs.push(arg);
    }
  }

  // Extract slug from filtered arguments
  let slugArg = nonOptionArgs[0] || "";
  let singleEpisodeUrl: string | null = null;
  let slug = slugArg || ""; // Default to empty string if not provided

  // Check if the arg is an episode URL
  if (slugArg.match(/https:\/\/www\.nts\.live\/shows\/.*\/episodes\/.*/)) {
    singleEpisodeUrl = slugArg;
    // Extract show slug from episode URL
    try {
      const url = new URL(slugArg);
      const pathParts = url.pathname.split("/");
      // Format should be /shows/{show_alias}/episodes/{episode_alias}
      if (
        pathParts.length >= 4 &&
        pathParts[1] === "shows" &&
        pathParts[3] === "episodes"
      ) {
        slug = pathParts[2] || ""; // Still extract the show slug
      } else {
        throw new Error(
          `Invalid NTS episode URL format. Expected format: https://www.nts.live/shows/{show-alias}/episodes/{episode-alias}`
        );
      }
    } catch (error) {
      throw new Error(
        `Invalid episode URL: ${slugArg}. Expected format: https://www.nts.live/shows/{show-alias}/episodes/{episode-alias}`
      );
    }
  } else if (slugArg.startsWith("https://www.nts.live/shows/")) {
    // Extract the slug from the show URL using a URL object
    try {
      const url = new URL(slugArg);
      const pathParts = url.pathname.split("/");

      // The format should be /shows/{slug}
      if (pathParts.length === 3 && pathParts[1] === "shows" && pathParts[2]) {
        slug = pathParts[2];
      } else {
        throw new Error(
          `Invalid NTS show URL format. Expected format: https://www.nts.live/shows/{slug}`
        );
      }
    } catch (error) {
      throw new Error(
        `Invalid URL: ${slugArg}. Expected format: https://www.nts.live/shows/{slug}`
      );
    }
  }

  return { slug, options, singleEpisodeUrl };
}

// Function to fetch a single episode by URL
async function fetchSingleEpisode(episodeUrl: string): Promise<Episode> {
  try {
    // Extract show_alias and episode_alias from URL
    const url = new URL(episodeUrl);
    const pathParts = url.pathname.split("/");

    if (
      pathParts.length < 5 ||
      pathParts[1] !== "shows" ||
      pathParts[3] !== "episodes"
    ) {
      throw new Error("Invalid episode URL format");
    }

    const showAlias = pathParts[2];
    const episodeAlias = pathParts[4];

    if (!showAlias || !episodeAlias) {
      throw new Error(
        `Could not extract show alias or episode alias from URL: ${episodeUrl}`
      );
    }

    console.log(`Attempting to fetch episode: ${showAlias}/${episodeAlias}`);

    // First method: Direct fetch from the episode page
    try {
      // Fetch the episode data
      const response = await fetch(episodeUrl, {
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        console.log(
          `Page fetch failed: ${response.status} ${response.statusText}`
        );
        throw new Error(
          `Failed to fetch episode page: ${response.status} ${response.statusText}`
        );
      }

      const data = (await response.json()) as Record<string, any>;

      // Check if we got a valid episode object
      if (data.episode && data.episode.name) {
        console.log(
          `Successfully found episode data from page: ${data.episode.name}`
        );

        // Create a minimal Episode object with required fields
        const episode = data.episode as Episode;
        // Set default name if it's undefined
        if (!episode.name) {
          (episode as any).name = "Unknown Episode";
        }
        return episode;
      }

      console.log("Episode data not found in page response, trying API...");
    } catch (pageError) {
      console.log(`Error fetching episode page: ${String(pageError)}`);
      // Continue to API method
    }

    // Second method: API fetch (if page fetch failed or didn't have episode data)
    console.log(`Trying API endpoint for ${showAlias}/${episodeAlias}...`);

    // Try to get episode from API
    const apiUrl = `https://www.nts.live/api/v2/shows/${showAlias}/episodes/${episodeAlias}`;
    console.log(`API URL: ${apiUrl}`);

    const apiResponse = await fetch(apiUrl);

    if (!apiResponse.ok) {
      throw new Error(
        `Failed to fetch episode from API: ${apiResponse.status} ${apiResponse.statusText}`
      );
    }

    const apiData = (await apiResponse.json()) as Record<string, any>;
    console.log("API response received, checking for episode data...");

    // Debug the API response structure
    if (apiData) {
      console.log("API data structure:");
      console.log(`- Has 'results': ${!!apiData.results}`);

      if (apiData.results) {
        console.log(`- Results type: ${typeof apiData.results}`);
        if (Array.isArray(apiData.results)) {
          console.log(`- Results array length: ${apiData.results.length}`);
        }
      }
    }

    // Handle different response formats from the API
    if (apiData && apiData.results) {
      if (Array.isArray(apiData.results) && apiData.results.length > 0) {
        // Handle case where results is an array
        const episode = apiData.results[0] as Episode;
        console.log(
          `Found episode in API results array: ${episode.name || "Unnamed"}`
        );
        if (!episode.name) {
          (episode as any).name = "Unknown Episode";
        }
        return episode;
      } else {
        // Handle case where results is an object
        const episode = apiData.results as Episode;
        console.log(
          `Found episode in API results object: ${episode.name || "Unnamed"}`
        );
        if (!episode.name) {
          (episode as any).name = "Unknown Episode";
        }
        return episode;
      }
    } else if (apiData && apiData.episode) {
      // Some API endpoints return the episode directly
      const episode = apiData.episode as Episode;
      console.log(
        `Found episode directly in API data: ${episode.name || "Unnamed"}`
      );
      if (!episode.name) {
        (episode as any).name = "Unknown Episode";
      }
      return episode;
    } else if (apiData && apiData.name && apiData.episode_alias) {
      // The API returned the episode data directly at the top level
      console.log(
        `Found episode data at top level: ${apiData.name || "Unnamed"}`
      );
      // Use the API data directly as an Episode object
      const episode = apiData as unknown as Episode;
      if (!episode.name) {
        (episode as any).name = "Unknown Episode";
      }
      return episode;
    }

    // If we reach here, we couldn't find episode data in any expected format
    console.log(
      "No episode data found in any expected format in the API response"
    );
    console.log("API response keys:", Object.keys(apiData || {}).join(", "));
    throw new Error(
      "Could not retrieve episode data from NTS API - episode may not exist"
    );
  } catch (error) {
    console.error(chalk.red(`Error fetching episode: ${String(error)}`));
    throw error;
  }
}

// Function to download a single episode
async function downloadSingleEpisode(
  episodeUrl: string,
  options: CliOptions
): Promise<void> {
  displayHeader(`Downloading single episode: ${episodeUrl}`);

  try {
    // Fetch the episode
    const spinner = ora(`Fetching episode data`).start();
    const episode = await fetchSingleEpisode(episodeUrl);
    // Use an explicit string for the name
    const episodeName = episode.name || "Unknown Episode";
    spinner.succeed(`Found episode: ${chalk.green(episodeName)}`);

    // Extract show_alias
    const url = new URL(episodeUrl);
    const pathParts = url.pathname.split("/");
    const showAlias = pathParts[2];

    if (!showAlias) {
      throw new Error("Could not extract show alias from episode URL");
    }

    // Fetch show metadata (needed for artwork and other details)
    spinner.text = `Fetching show metadata`;
    spinner.start();
    const showData = await fetchShowMetadata(showAlias);
    // Use an explicit string for the name
    const showName = showData.name || "Unknown Show";
    spinner.succeed(`Found show: ${chalk.green(showName)}`);

    // Create output directory based on show slug
    const outputDir = path.join(process.cwd(), showAlias);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Load download registry
    const registry = getDownloadRegistry(outputDir);

    // Create a progress bar for the single episode
    const progressBar = new cliProgress.SingleBar(
      {
        format: `${chalk.cyan("{bar}")} | {percentage}% | ${chalk.yellow(
          "{status}"
        )} | {name}`,
        barCompleteChar: "\u2588",
        barIncompleteChar: "\u2591",
        hideCursor: true,
      },
      cliProgress.Presets.shades_classic
    );

    progressBar.start(1, 0, {
      status: "WAITING",
      name: episodeName,
    });

    // Download the episode
    try {
      await downloadEpisode(
        episode,
        showData,
        outputDir,
        1, // Track number
        registry,
        progressBar,
        options,
        1, // Episode index (not important here)
        1 // Concurrent position
      );

      progressBar.stop();

      // Display summary for the single episode
      displaySummary({
        downloaded: 1,
        skipped: 0,
        failed: 0,
        showName: showName,
      });
    } catch (error) {
      progressBar.stop();
      throw error;
    }
  } catch (error) {
    console.error(chalk.red(`Error: ${String(error)}`));
    process.exit(1);
  }
}

async function main() {
  // Parse command line arguments
  const { slug, options, singleEpisodeUrl } = parseArguments();

  if (!slug) {
    console.error(
      chalk.red("Please provide a show slug or URL as an argument")
    );
    console.error(
      chalk.yellow(
        "Usage: bun run index.ts <show-slug | show-url | episode-url> [options]"
      )
    );
    console.error(chalk.yellow("Examples:"));
    console.error(chalk.yellow("  bun run index.ts malibu"));
    console.error(
      chalk.yellow("  bun run index.ts https://www.nts.live/shows/malibu")
    );
    console.error(
      chalk.yellow(
        "  bun run index.ts https://www.nts.live/shows/malibu/episodes/malibu-5th-july-2023"
      )
    );
    console.error(chalk.yellow("Options:"));
    console.error(
      chalk.yellow("  -v, --verbose     Show detailed command output")
    );
    console.error(
      chalk.yellow(
        "  -c, --concurrency <num>  Set number of concurrent downloads (default: 3)"
      )
    );
    process.exit(1);
  }

  // Handle single episode download if URL is provided
  if (singleEpisodeUrl) {
    await downloadSingleEpisode(singleEpisodeUrl, options);
    return;
  }

  const headerText = `Archiving NTS show: ${slug} (Concurrency: ${
    options.concurrency
  }${options.verbose ? ", Verbose: yes" : ""})`;
  displayHeader(headerText);

  try {
    // Fetch show metadata
    const showData = await fetchShowMetadata(slug);

    // Fetch all episodes
    const allEpisodes = await fetchAllEpisodes(slug);

    // Create output directory based on show slug instead of name
    const outputDir = path.join(process.cwd(), slug);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Load download registry
    const registry = getDownloadRegistry(outputDir);

    console.log(
      chalk.blue(
        `\nFound ${chalk.yellow(
          registry.length.toString()
        )} previously downloaded episodes`
      )
    );

    // Sort episodes by broadcast date (oldest first)
    const sortedEpisodes = [...allEpisodes].sort(
      (a, b) =>
        new Date(a.broadcast).getTime() - new Date(b.broadcast).getTime()
    );

    // Create a progress bar
    const progressBar = new cliProgress.SingleBar(
      {
        format: `${chalk.cyan(
          "{bar}"
        )} | {percentage}% | {value}/{total} | ${chalk.yellow(
          "{status}"
        )} | [${chalk.blue("{concurrent}")}] {name}`,
        barCompleteChar: "\u2588",
        barIncompleteChar: "\u2591",
        hideCursor: true,
      },
      cliProgress.Presets.shades_classic
    );

    progressBar.start(sortedEpisodes.length, 0, {
      status: "WAITING",
      name: "",
    });

    // Process episodes with concurrency
    const { downloaded, skipped, failed } =
      await processEpisodesWithConcurrency(
        sortedEpisodes,
        showData,
        outputDir,
        registry,
        progressBar,
        options
      );

    progressBar.stop();

    // Display summary
    displaySummary({
      downloaded,
      skipped,
      failed,
      showName: showData.name,
    });
  } catch (error: unknown) {
    console.error(
      chalk.red("Error:"),
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
}

main();
