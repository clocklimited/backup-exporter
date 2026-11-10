# backup-exporter

Encrypts the latest completed native database backup from each configured Northflank addon with age and streams it to an S3-compatible bucket. It exports existing backups; it does not create them.

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

The newest backup must be no more than 24 hours old. Set `BACKUP_MAX_AGE_HOURS` to change this, for example `192` for weekly backups.

Run with:

```sh
npm start
```

## Scheduling and access

Configure native dump backups for each addon, then schedule this job after those backups finish. Disk snapshots cannot be exported. Allow enough job runtime for all transfers and disable overlapping runs; large backups can take hours.

The Northflank token needs read access to addon backups and their download links. The storage identity needs `s3:PutObject` and `s3:AbortMultipartUpload` on the project's object prefix. It does not need to list, read or delete completed objects.

Configure private access, versioning, retention and lifecycle rules in the storage service. Include a lifecycle rule to clear incomplete multipart uploads that may remain after an interrupted job or failed completion request. The exporter does not change bucket settings or object retention.

## Behaviour

Addons export sequentially. If one fails, the exporter attempts the others and exits with a nonzero status. Enable job failure alerts.

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
