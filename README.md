# backup-exporter

Streams the latest completed native database backup from each configured Northflank addon to an S3-compatible bucket. It exports existing backups; it does not create them.

## Setup

Use Node.js 24 and install dependencies with `npm ci`, or build the included Dockerfile.

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
```

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

Downloads must return HTTP 200 and match the backup's expected byte size. Uploads use SHA-256 request checksums and stream directly to storage with two buffered parts, starting at 64 MiB each. A 400 GiB backup fits within the multipart limit without loading the full file into memory or writing it to disk.

Objects are stored as:

```text
project-id/addon-id/backup-id.gz
```

Zstandard backups use `.zstd`. Re-exporting the same backup uses the same key and creates another version if bucket versioning is enabled.

To restore, download the required object version and import it with the database's native restore tools. Test an upload and restore on a small database before relying on the job.

## Development

```sh
npm test
npm run format:check
```
