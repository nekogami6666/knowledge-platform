> **Vendored from** `queeenb-com/QB-Meeting-Ops` `sidecars/discordjs-recorder` @ `3c699fc779c4`(2026-07-17・ADR-0020 D1)。
> 上流の改善は必要時に手動で取り込む(共有パッケージ化はしない)。コード変更は package.json の name のみ。
> stratum では録音 bot トークンを `TOKEN_ENV=RECORDER_DISCORD_TOKEN` で指す(HTTP 契約・env は上流と同一)。

# Discord.js Recorder Sidecar

Experimental DAVE-capable recorder sidecar for `qb-meeting-ops`.

This sidecar implements the local HTTP contract in:

- [../../docs/recorder-sidecar-http-contract.md](../../docs/recorder-sidecar-http-contract.md)

## Status

This sidecar has passed the first real Discord recording check on the current host.
It is the current initial backend candidate, but should still pass longer soak testing before being treated as fully hardened production infrastructure.

Why it exists:

- `@discordjs/voice` documents DAVE protocol support through `@snazzah/davey`.
- Node.js 22 is already available on the current host.
- It is faster to validate the sidecar contract than a C++ DPP build.

Known caveat:

- Discord voice receive by bots is not officially guaranteed.
- This implementation records per-user PCM streams when users speak, pads silence to preserve approximate meeting duration, then mixes them with ffmpeg.
- It must pass a real Discord soak test and `recording_quality` before being considered production-ready.

For continuous operation, see [../../docs/operations-systemd.md](../../docs/operations-systemd.md).

## Install

```bash
cd /home/vm/openclaw-workspaces/qb-meeting-ops/sidecars/discordjs-recorder
npm install
```

`.npmrc` omits optional native dependencies. This keeps `npm audit` clean by avoiding the vulnerable native `@discordjs/opus` chain.

Important:

- DAVE still needs a native binding.
- We explicitly depend on `@snazzah/davey-linux-x64-gnu` for this host.
- Do not remove that dependency unless the sidecar is moved to a different platform and the matching DAVE package is added.

## Run

Do not print the token. Source the existing env file only.

```bash
cd /home/vm/openclaw-workspaces/qb-meeting-ops/sidecars/discordjs-recorder
set -a
source /home/vm/.openclaw/.env
set +a

TOKEN_ENV=DISCORD_BOT_TOKEN_RECORDER \
HOST=127.0.0.1 \
PORT=9488 \
npm start
```

Then run the existing control plane against port `9488`:

```bash
cd /home/vm/openclaw-workspaces/qb-meeting-ops
source .venv/bin/activate
set -a
source /home/vm/.openclaw/.env
set +a

PYTHONPATH=src python -m qb_meeting_ops.cli \
  --db data/meeting-ops.sqlite3 \
  run-discord-adapter \
  --config config/meeting_channels.yaml \
  --storage-root /home/vm/openclaw-data/qb-meetings \
  --token-env DISCORD_BOT_TOKEN_MEETING_OPS \
  --recording-backend remote-http \
  --recorder-service-url http://127.0.0.1:9488
```

Health check:

```bash
PYTHONPATH=src python -m qb_meeting_ops.cli \
  recorder-health \
  --recorder-service-url http://127.0.0.1:9488
```

## Verification

After a finalized session:

```bash
PYTHONPATH=src python -m qb_meeting_ops.cli \
  --db data/meeting-ops.sqlite3 \
  validate-recording \
  --meeting-id mtg-...
```

The session should not proceed to transcription unless `recording_quality` succeeds.
