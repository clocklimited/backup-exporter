# backup-exporter

Streams existing Northflank native database backups into an S3-compatible bucket. Supports one or several addons in a project, keeps the entire dump off the job's local disk, and writes a SHA-256 integrity manifest beside each dump.

## Runtime and installation

Use Node.js 24 LTS. Dependencies are locked with npm; this replaces the old Yarn lockfile.

```sh
npm ci
npm test
npm start
```

The Docker image installs production dependencies and runs as the unprivileged `node` user. Local `.env` files are supported and excluded from Docker builds. The exporter uses Northflank's documented read-only REST endpoints and Node's built-in fetch instead of the old Northflank client and node-fetch dependencies.

## Northflank setup

Keep an existing **native dump** backup schedule for every addon you export. Disk snapshots cannot be downloaded. This job exports a completed backup; it does not initiate one.

Schedule the export after the dumps normally finish. The job selects the newest completed `sameAddon` backup across all result pages and fails if it is too old. A failed or in-progress backup is never selected.

Create a Northflank API token scoped to the relevant project and the read permissions for listing addon backups and generating backup download links. No create, update, restore or delete permissions are needed. Existing tokens using `addon:general:read` can continue to be used; project-management access is no longer called by this exporter.

Restrict the runtime secret group to this export job. Add:

| Variable                                    | Meaning / default                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `BACKUP_EXPORTER_TOKEN`                     | Required Northflank API token                                                |
| `NF_PROJECT_ID`                             | Required project ID; one project per job                                     |
| `DATABASE_ADDON_IDS`                        | Comma-separated explicit list, e.g. `production-database,analytics-database` |
| `DATABASE_ADDON_ID`                         | Existing single-addon setting; used when the plural setting is absent        |
| Neither addon setting                       | Exports `production-database`, as before                                     |
| `S3_ENDPOINT`                               | Provider endpoint; optional for AWS S3                                       |
| `S3_REGION`                                 | Required bucket region                                                       |
| `S3_BUCKET`                                 | Required destination bucket                                                  |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Required dedicated upload identity                                           |
| `S3_FORCE_PATH_STYLE`                       | `true` by default; configurable for other S3 services                        |
| `S3_KEY_PREFIX`                             | Optional prefix before the project folder                                    |
| `BACKUP_MAX_AGE_HOURS`                      | `24`; measured from the dump's creation time                                 |
| `EXPORT_TIMEOUT_HOURS`                      | `24` per addon, including download, upload and manifest                      |
| `S3_MULTIPART_PART_SIZE_MB`                 | `64` MiB minimum; grows automatically for larger objects                     |
| `S3_UPLOAD_CONCURRENCY`                     | `2` concurrent parts                                                         |

The plural addon list takes precedence. Addons export sequentially to bound memory. If one fails, the remaining addons are still attempted and the job ultimately exits with status 1. Enable Northflank job failure alerts.

For weekly dumps, choose a matching freshness window, e.g. `BACKUP_MAX_AGE_HOURS=192` (8 days). Separate jobs are preferable when addons have different schedules/freshness requirements.

### Large database jobs

The old README's `activeDeadlineSeconds: 1800` stops jobs after 30 minutes. Change the **actual Northflank job deadline** for large transfers; changing the exporter's timeout alone does not change Northflank's deadline. Allow time for all sequential addons and cleanup, and keep the normal transfer time within the job's schedule. Use `concurrencyPolicy: forbid` to avoid overlapping exports.

With 64 MiB parts, a **400 GiB compressed dump uses 6,400 parts**, below S3's 10,000-part limit. Default part buffering is approximately 128 MiB, plus fetch, checksum and SDK overhead; provide at least 512 MiB RAM and measure during the pilot. Very large objects cause the part size and memory requirement to grow. No full dump is written to ephemeral storage.

For context, 400 GB takes about 4.4 hours at 25 MB/s, before other overhead. The actual **compressed export size**, rather than the live database size, determines this. Northflank's `config.size` must describe the downloadable backup's byte size; confirm this in the live pilot.

## Wasabi configuration

For `backup-bucket` in UK `eu-west-1`:

```env
S3_ENDPOINT=https://s3.eu-west-1.wasabisys.com
S3_REGION=eu-west-1
S3_BUCKET=backup-bucket
DATABASE_ADDON_IDS=production-database,analytics-database
BACKUP_MAX_AGE_HOURS=24
EXPORT_TIMEOUT_HOURS=24
```

Provide the Wasabi access key and secret through the job's secret group. Use a dedicated sub-user with only the custom upload policy below, scoped to the project folder. Replace `PROJECT_ID`; account for `S3_KEY_PREFIX` if set.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::backup-bucket/PROJECT_ID/*"
    }
  ]
}
```

The exporter needs no bucket listing, object reading, completed-object deletion, IAM administration, ACL changes or retention changes. The abort permission removes unfinished multipart uploads, not completed backups. Do not attach other broad policies to the upload user.

Keep the bucket private. Configure **Versioning**, **Object Lock**, and **Default Object Retention: Compliance, 90 days** before uploading. The exporter relies on the bucket's default retention and does not send per-object retention overrides. An administrator changing that default can affect future uploads, so check uploaded versions and monitor the bucket settings separately.

An AWS SDK v3 uploader streams multipart uploads. SHA-256 request checksums are selected explicitly rather than relying on provider-dependent checksum defaults. Wasabi compatibility, retention and restores still need live verification.

Existing lifecycle guidance for dated backups remains: current-version expiry at 91 days, noncurrent-version deletion 1 day after becoming noncurrent, and unfinished multipart cleanup after 7 days. Object Lock can delay permanent deletion.

## Stored files and integrity

Download links must be direct HTTPS links. Redirects are rejected so the transfer cannot silently downgrade to HTTP.

New exports use this structure:

```text
[optional-prefix]/project/addon/backup-created-at/backup-uid/dump.gz
[optional-prefix]/project/addon/backup-created-at/backup-uid/dump.gz.manifest.json
```

Zstandard dumps use `dump.zstd` instead. Existing objects under the old `project/backup-id` layout are left in place.

The manifest records the project/addon, backup timestamps, addon version, compression, object key/version ID, exact size and full-file SHA-256. It contains no download URL or access keys.

Downloads must return HTTP 200. Their Content-Length, when provided, must match Northflank's size; the actual streamed byte count must also match. Empty, truncated, oversized or transparently decompressed responses fail. A manifest is published only after the dump upload succeeds. A manifest upload failure fails the export, even if the dump already exists.

Repeated exports of the same native backup create additional object and manifest versions in a versioned bucket. They do not destroy earlier protected versions, but they do consume storage. Retries are not deduplicated. When restoring, select a trusted historical manifest version and use its recorded dump version ID. A hash detects corruption; it does not establish that the database contents are correct.

## Live pilot and restore

Automated tests use a local S3 protocol server with the real SDK. They do **not** prove Wasabi account permissions, Object Lock behavior, a 400 GB transfer, or database restorability.

1. Export a small test database using the actual job identity. Verify that its dump and manifest are private, that their versions show **Compliance**, and that retain-until dates are at least 90 days after upload. Then run a larger multipart export and check its retention too.
2. Check that the job identity cannot read a dump, delete a completed version, or change retention/bucket settings. Verify that a failed multipart upload can be aborted.
3. Using an administrator, upload a **harmless test object**, record its version ID, and attempt to permanently delete that version or shorten its Compliance retention. Both must fail. A deletion without a version ID can create a delete marker, which is not an immutability test.
4. Give each custodian a separate restore identity. Download a trusted manifest version and its exact dump version using that identity. Each person should complete the exercise independently.
5. Verify size and checksum, then restore into a separate test database with the appropriate Northflank/native database import tools and compression handling. Check expected collections/tables, counts and representative records. Record the restore commands, required tool/database versions and elapsed time before approving production use.

For read/retention checks, use a separate restore/admin AWS CLI profile. Never put that profile's credentials into the export job:

```sh
aws --profile wasabi-restore --region eu-west-1 \
  --endpoint-url https://s3.eu-west-1.wasabisys.com \
  s3api get-object-retention --bucket backup-bucket \
  --key "<DUMP_KEY>" --version-id "<DUMP_VERSION_ID>"

aws --profile wasabi-restore --region eu-west-1 \
  --endpoint-url https://s3.eu-west-1.wasabisys.com \
  s3api get-object --bucket backup-bucket \
  --key "<DUMP_KEY>" --version-id "<DUMP_VERSION_ID>" dump.zstd

npm run verify -- dump.zstd.manifest.json dump.zstd
```

Download the matching manifest separately, also specifying its chosen historical version ID. The verification command reads local files, uses bounded memory and exits nonzero on size or hash mismatch. It does not restore the database.

## Development

```sh
npm ci
npm test
npm run format:check
```

Tests cover multi-addon configuration and partial failures, API pagination and backup freshness, real SDK single/multipart requests, failed/empty/truncated downloads, multipart cleanup and deadlines, integrity manifests, restore checksum verification and 400 GiB part sizing.

Provider references:

- [Northflank backup listing](https://northflank.com/docs/v1/api/project/addons/list-addon-backups)
- [Northflank download links](https://northflank.com/docs/v1/api/project/addons/get-backup-download-link)
- [Wasabi default Object Lock retention](https://docs.wasabi.com/docs/object-locking-enable)
- [Wasabi additional checksums](https://docs.wasabi.com/docs/additional-checksums)
- [AWS multipart permissions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)
