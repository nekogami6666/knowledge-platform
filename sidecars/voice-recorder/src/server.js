import { createServer } from "node:http";
import { mkdir, readdir, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

import { Client, GatewayIntentBits } from "discord.js";
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from "@discordjs/voice";
import prism from "prism-media";

const BACKEND_NAME = "discordjs-recorder-v1-experimental";
const TOKEN_ENV = process.env.TOKEN_ENV || "DISCORD_BOT_TOKEN_RECORDER";
const TOKEN = process.env[TOKEN_ENV];
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || "9488");
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";

const activeRecordings = new Map();
const finalizeJobs = new Map();
let lastActivity = "client_starting";
let startupError = null;
let ready = false;

if (!TOKEN) {
  console.error(`Recorder token env var is not set: ${TOKEN_ENV}`);
  process.exit(2);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once("clientReady", () => {
  ready = true;
  lastActivity = null;
});

client.on("error", (error) => {
  startupError = error;
  lastActivity = `client_error:${error.message}`;
});

client.login(TOKEN).catch((error) => {
  startupError = error;
  lastActivity = `client_start_failed:${error.message}`;
});

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, {
        backend_name: BACKEND_NAME,
        ok: ready && startupError === null,
        detail: startupError ? `client_start_failed:${startupError.message}` : lastActivity,
        active_recordings: activeRecordings.size,
      });
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/recordings/status/")) {
      const meetingId = decodeURIComponent(request.url.slice("/recordings/status/".length));
      const handle = getFinalizeStatus(meetingId);
      if (!handle) {
        sendJson(response, 404, { error: "not_found", detail: `finalize job not found: ${meetingId}` });
        return;
      }
      sendJson(response, 200, handle);
      return;
    }

    if (request.method === "POST" && request.url === "/recordings/start") {
      const payload = await readJson(request);
      const handle = await startRecording(payload);
      sendJson(response, 200, handle);
      return;
    }

    if (request.method === "POST" && request.url === "/recordings/finalize") {
      const payload = await readJson(request);
      const handle = await finalizeRecording(payload);
      sendJson(response, 200, handle);
      return;
    }

    if (request.method === "POST" && request.url === "/recordings/abort") {
      const payload = await readJson(request);
      const handle = await abortRecording(payload);
      sendJson(response, 200, handle);
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    sendJson(response, 500, {
      error: "internal_error",
      detail: `${error.name}: ${error.message}`,
      stack: error.stack,
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`${BACKEND_NAME} listening on http://${HOST}:${PORT}`);
});

async function startRecording(payload) {
  ensureReady();
  const record = payload.record;
  if (!record?.meeting_id || !record?.guild_id || !record?.voice_channel_id || !record?.local_root_dir) {
    throw new Error("invalid start payload");
  }
  if (activeRecordings.has(record.meeting_id)) {
    throw new Error(`recording already active: ${record.meeting_id}`);
  }

  const tempDir = join(record.local_root_dir, "tmp", "discordjs-recorder");
  await mkdir(tempDir, { recursive: true });
  const guild = await client.guilds.fetch(record.guild_id);
  const channel = await guild.channels.fetch(record.voice_channel_id);
  if (!channel || !channel.isVoiceBased()) {
    throw new Error(`voice channel not found: ${record.voice_channel_id}`);
  }

  lastActivity = `connecting_voice_client:${record.voice_channel_id}`;
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

  const state = {
    meetingId: record.meeting_id,
    guildId: record.guild_id,
    localRootDir: record.local_root_dir,
    tempDir,
    connection,
    participantIds: new Set(),
    streams: new Map(),
    startedAt: Date.now(),
    decodedFrames: 0,
    decodeErrors: 0,
    lastDecodeError: null,
  };
  activeRecordings.set(record.meeting_id, state);

  connection.receiver.speaking.on("start", (userId) => {
    attachUserStream(state, userId);
  });

  lastActivity = `recording_started:${record.meeting_id}`;
  return handle(record, "recording", {
    duration_ms: null,
    bytes_written: null,
    participant_ids: [],
    metadata: {},
  });
}

function attachUserStream(state, userId) {
  if (state.streams.has(userId)) {
    return;
  }
  const pcmPath = join(state.tempDir, `participant-${userId}.pcm`);
  const opusStream = state.connection.receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.Manual,
    },
  });
  const decoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });
  const writer = createWriteStream(pcmPath, { flags: "a" });
  const streamState = {
    opusStream,
    decoder,
    writer,
    pcmPath,
    lastPcmEndMs: 0,
    closed: false,
  };
  state.participantIds.add(String(userId));
  state.streams.set(userId, streamState);
  decoder.on("data", (chunk) => {
    const chunkStartedMs = Math.max(0, Date.now() - state.startedAt);
    if (chunkStartedMs > streamState.lastPcmEndMs) {
      writer.write(silencePcm(chunkStartedMs - streamState.lastPcmEndMs));
      streamState.lastPcmEndMs = chunkStartedMs;
    }
    writer.write(chunk);
    state.decodedFrames += Math.max(1, Math.floor(chunk.length / 3840));
    streamState.lastPcmEndMs += pcmDurationMs(chunk.length);
  });
  decoder.on("error", (error) => {
    state.decodeErrors += 1;
    state.lastDecodeError = error.message;
  });
  writer.on("close", () => {
    streamState.closed = true;
  });
  opusStream.pipe(decoder);
  opusStream.on("error", (error) => {
    state.decodeErrors += 1;
    state.lastDecodeError = error.message;
  });
}

async function finalizeRecording(payload) {
  const record = payload.record;
  const state = activeRecordings.get(record?.meeting_id);
  if (!state) {
    const existing = finalizeJobs.get(record?.meeting_id);
    if (existing) {
      return existing.handle;
    }
    throw new Error(`active recording not found: ${record?.meeting_id}`);
  }
  activeRecordings.delete(record.meeting_id);
  lastActivity = `finalizing_recording:${record.meeting_id}`;
  const pendingHandle = handle(record, "finalizing", {
    duration_ms: null,
    bytes_written: null,
    participant_ids: [...state.participantIds].sort(),
    metadata: {
      decode_errors: state.decodeErrors,
      last_decode_error: state.lastDecodeError,
    },
  });
  finalizeJobs.set(record.meeting_id, {
    meetingId: record.meeting_id,
    state: "finalizing",
    handle: pendingHandle,
  });
  void runFinalizeJob(record, state);
  return pendingHandle;
}

function silencePcm(durationMs) {
  const bytes = Math.max(0, Math.round((durationMs / 1000) * 48000 * 2 * 2));
  return Buffer.alloc(bytes);
}

function pcmDurationMs(byteLength) {
  return Math.max(0, Math.round((byteLength / (48000 * 2 * 2)) * 1000));
}

function waitForWriterClose(streamState) {
  if (streamState.closed) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    streamState.writer.once("close", resolve);
    streamState.writer.once("error", reject);
  });
}

async function abortRecording(payload) {
  const record = payload.record;
  const state = activeRecordings.get(record?.meeting_id);
  if (state) {
    activeRecordings.delete(record.meeting_id);
    state.connection.destroy();
  }
  lastActivity = `recording_aborted:${record?.meeting_id}`;
  return handle(record, "aborted", {
    duration_ms: null,
    bytes_written: 0,
    participant_ids: [],
    metadata: {
      reason: payload.reason || "unspecified",
    },
  });
}

function getFinalizeStatus(meetingId) {
  return finalizeJobs.get(meetingId)?.handle || null;
}

async function runFinalizeJob(record, state) {
  try {
    for (const streamState of state.streams.values()) {
      const elapsedMs = Math.max(0, Date.now() - state.startedAt);
      if (elapsedMs > streamState.lastPcmEndMs) {
        streamState.writer.write(silencePcm(elapsedMs - streamState.lastPcmEndMs));
        streamState.lastPcmEndMs = elapsedMs;
      }
      streamState.opusStream.destroy();
      streamState.decoder.destroy();
      streamState.writer.end();
    }
    await Promise.all([...state.streams.values()].map(waitForWriterClose));
    state.connection.destroy();

    const outputPath = join(record.local_root_dir, "recording.m4a");
    const pcmFiles = (await readdir(state.tempDir))
      .filter((name) => name.endsWith(".pcm"))
      .map((name) => join(state.tempDir, name));
    if (pcmFiles.length === 0) {
      throw new Error("no participant audio was captured by the recorder");
    }
    await transcodePcmFiles(pcmFiles, outputPath);
    const outputStat = await stat(outputPath);
    const completedHandle = handle(record, "ok", {
      duration_ms: Math.max(0, Date.now() - state.startedAt),
      bytes_written: outputStat.size,
      participant_ids: [...state.participantIds].sort(),
      metadata: {
        decoded_frames: state.decodedFrames,
        decode_errors: state.decodeErrors,
        last_decode_error: state.lastDecodeError,
        dave_enabled: true,
        audio_format: "pcm_s16le:48000:2",
        sidecar_version: BACKEND_NAME,
        voice_library: "@discordjs/voice",
      },
    });
    finalizeJobs.set(record.meeting_id, {
      meetingId: record.meeting_id,
      state: "ok",
      handle: completedHandle,
    });
    lastActivity = `recording_finalized:${record.meeting_id}`;
  } catch (error) {
    finalizeJobs.set(record.meeting_id, {
      meetingId: record.meeting_id,
      state: "failed",
      handle: handle(record, "failed", {
        duration_ms: Math.max(0, Date.now() - state.startedAt),
        bytes_written: null,
        participant_ids: [...state.participantIds].sort(),
        metadata: {
          error: error.message,
          error_detail: error.stack || error.message,
          decode_errors: state.decodeErrors,
          last_decode_error: state.lastDecodeError,
          sidecar_version: BACKEND_NAME,
        },
      }),
    });
    lastActivity = `recording_finalize_failed:${record.meeting_id}`;
  }
}

async function transcodePcmFiles(pcmFiles, outputPath) {
  const args = ["-y", "-loglevel", "error"];
  for (const pcmFile of pcmFiles) {
    args.push("-f", "s16le", "-ar", "48000", "-ac", "2", "-i", pcmFile);
  }
  if (pcmFiles.length === 1) {
    args.push("-c:a", "aac", "-b:a", "128k", outputPath);
  } else {
    args.push("-filter_complex", `amix=inputs=${pcmFiles.length}:duration=longest:normalize=0`);
    args.push("-c:a", "aac", "-b:a", "128k", outputPath);
  }
  await runCommand(FFMPEG_BIN, args);
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
    });
  });
}

function handle(record, status, values) {
  return {
    file_path: join(record.local_root_dir, "recording.m4a"),
    backend_name: BACKEND_NAME,
    bytes_written: values.bytes_written,
    duration_ms: values.duration_ms,
    participant_ids: values.participant_ids,
    status,
    metadata: values.metadata,
  };
}

function ensureReady() {
  if (startupError) {
    throw startupError;
  }
  if (!ready) {
    throw new Error("discord client is not ready");
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(response, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  for (const state of activeRecordings.values()) {
    getVoiceConnection(state.guildId)?.destroy();
  }
  client.destroy();
  server.close(() => process.exit(0));
}
