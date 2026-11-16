# backup-exporter

Encrypts the latest completed native database backup found on the first page for each configured Northflank addon with age and streams it to an S3-compatible bucket. By default it exports existing backups. An opt-in mode creates a fresh native dump before exporting.

## Setup

Use Node.js 24, install the `age` command (on Ubuntu: `sudo apt install age`), and install dependencies with `npm ci`. The included Dockerfile installs age automatically.

Set these environment variables, either in the job's secrets or a local `.env` file:

```env
NF_PROJECT_ID=my-project
DATABASE_ADDON_IDS=production-database,analytics-database
BACKUP_EXPORTER_TOKEN=<northflank-api-token>
S3_ENDPOINT=https://s3.example.com
S3_REGION=<bucket-region>
S3_BUCKET=<bucket-name>
S3_ACCESS_KEY_ID=<access-key>
S3_SECRET_ACCESS_KEY=<secret-key>
AGE_RECIPIENT=<public-key-from-recipient.txt>
```

`AGE_RECIPIENT` is required and must be one native X25519 age public key beginning `age1`. Paste the contents of `recipient.txt`, not its filename. The exporter validates the key with age before contacting Northflank. Missing or invalid keys, a missing age binary, or encryption errors fail the export; there is no unencrypted fallback. Never give the exporter a private key or passphrase.

`DATABASE_ADDON_ID` accepts a single addon. If neither addon variable is set, the exporter uses `production-database`. `DATABASE_ADDON_IDS` takes precedence. Omit `S3_ENDPOINT` when using the default AWS S3 endpoint.

The exporter requests only page 1, with up to 50 backups, and selects the newest completed native backup from those results. It fails if that page contains no eligible backup or the selected backup is more than 24 hours old; it does not search older pages. Set `BACKUP_MAX_AGE_HOURS` to change the age limit, for example `192` for weekly backups.

Run with:

```sh
npm start
```

## Scheduling and access

Configure native dump backups for each addon, then schedule this job after those backups finish. Disk snapshots cannot be exported. Allow enough job runtime for all transfers and disable overlapping runs; large backups can take hours.

The Northflank token needs read access to addon backups and their download links. The storage identity needs `s3:PutObject` and `s3:AbortMultipartUpload` on the project's object prefix. It does not need to list, read or delete completed objects.

Configure private access, versioning, retention and lifecycle rules in the storage service. Include a lifecycle rule to clear incomplete multipart uploads that may remain after an interrupted job or failed completion request. The exporter does not change bucket settings or object retention.

## Infrequent full backups

For a single addon that should only be dumped when this job runs, set `BACKUP_CREATE_NATIVE=true`. The job requests one native zstd dump, logs its ID, waits for that exact dump to complete, then uses the normal age-encrypted upload path. It does not use an older backup if creation fails, and it does not need a separate native dump schedule.

The Northflank token additionally needs `Project > Addons > General > Update` for the target addon to create the dump. Scope this permission to the intended project/addon. Wasabi permissions and key custody are unchanged.

`BACKUP_CREATION_TIMEOUT_SECONDS` defaults to 14400 (four hours). The Northflank job deadline must allow time for both dump creation and upload. Keep `runOnSourceChange=never`, `concurrencyPolicy=forbid` and automatic retries disabled so rebuilds and automatic retry attempts do not create extra large dumps. Manual runs ignore Northflank's concurrency policy: check that no dump/export is active before triggering one.

On failure, inspect the logged dump ID. Set `BACKUP_ID=<id>` as a **per-run override** to reuse that exact dump; it takes precedence over `BACKUP_CREATE_NATIVE`, and polls it if still running. The regular freshness check still applies. A creation request timeout is ambiguous: check Northflank for a dump that may already have started before retrying. No native or offsite backups are deleted by this mode. Manual native dumps need a separately agreed cleanup policy; do not assume they inherit a deleted schedule's retention.

For Tigers, `10 6 16 2,5,8,11 *` runs at 06:10 UTC on 16 February, May, August and November. It is quarterly, not an exact 90-day interval. Enable job failure notifications in Northflank before relying on unattended runs; this exporter itself does not send alerts.

## Behaviour

Addons export sequentially. If one fails, the exporter attempts the others and exits with a nonzero status. Enable job failure alerts.

The download times out after five minutes waiting for response headers or the next chunk. Set `BACKUP_DOWNLOAD_IDLE_TIMEOUT_SECONDS` to override this (positive whole seconds). The timer pauses while downstream encryption or upload applies backpressure; it does not limit total transfer duration. A timeout fails that addon, attempts multipart cleanup, and allows the next addon to run. Keep a job runtime limit and incomplete-multipart lifecycle cleanup configured.

Downloads must return HTTP 200 and match the backup's expected byte size. The compressed source is streamed through age without writing it to disk. Each backup becomes one encrypted object. The upload can complete only after the download size check and age process both succeed.

Uploads use SHA-256 request checksums and two buffered parts, starting at 64 MiB each. Part sizing allows for encryption overhead, and the encrypted stream is capped at that bound. The source's byte length is not sent as the ciphertext length. A 400 GiB backup fits within the multipart limit without loading the full file into memory. The encrypted size must fit within the 5 TB object limit.

Objects are stored as:

```text
project-id/addon-id/backup-id.gz.age
```

Zstandard backups use `.zst.age`. Re-exporting the same backup uses the same object key and creates another version if bucket versioning is enabled. Existing `.gz`/`.zst` objects are unchanged and are not protected by the new client-side key.

## Restore

Download the required object version to a trusted recovery computer. Decrypt it using the passphrase-protected private key from a custodian's USB, then import the resulting archive with the database's native restore tools:

```sh
age -d -i /media/usb/offsite-backup-recovery/identity.age -o restored-backup.zst downloaded-backup.zst.age
```

Choose a new output filename (`-o` overwrites existing files). Enter the passphrase interactively; do not put it in the command or the exporter's environment. Use `.gz` filenames for gzip backups. An unattended restore tester needs separate consideration because giving it a private key adds another recovery and purge dependency. Test a real encrypted export, decryption and database restore before relying on this integration.

## Development

```sh
npm test
npm run format:check
```
