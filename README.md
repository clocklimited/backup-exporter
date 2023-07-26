# backup-exporter

Exports Northflank NATIVE backups to S3 compatible buckets.

## Setup

Ensure there's a backup schedule for native backups:

```json
{
  "backupType": "dump",
  "scheduling": {
    "interval": "daily",
    "minute": [
      0
    ],
    "hour": [
      6
    ],
    "day": [
      0
    ]
  },
  "compressionType": "zstd",
  "retentionTime": 60
},
```

Add a CronJob for the task:

```json
{
  "kind": "CronJob",
  "spec": {
    "name": "backup-exporter-production",
    "billing": {
      "deploymentPlan": "nf-compute-200"
    },
    "backoffLimit": 0,
    "runOnSourceChange": "never",
    "activeDeadlineSeconds": 1800,
    "deployment": {
      "docker": {
        "configType": "default"
      },
      "buildpack": {
        "configType": "default"
      },
      "storage": {
        "ephemeralStorage": {
          "storageSize": 1024
        }
      },
      "vcs": {
        "projectUrl": "https://github.com/clocklimited/backup-exporter",
        "projectType": "github",
        "accountLogin": "clocklimited",
        "projectBranch": "master"
      }
    },
    "buildSettings": {
      "dockerfile": {
        "buildEngine": "kaniko",
        "dockerFilePath": "/Dockerfile",
        "dockerWorkDir": "/"
      }
    },
    "runtimeEnvironment": {
    },
    "schedule": "0 12 * * *",
    "concurrencyPolicy": "forbid",
    "healthChecks": [],
    "buildConfiguration": {
      "pathIgnoreRules": [],
      "isAllowList": false,
      "ciIgnoreFlagsEnabled": false
    },
    "buildArguments": {},
    "disabledCI": false,
    "suspended": false
  }
}
```

The above examples set the native dump to occur at 0600, and then the export at 1200.

In the CronJob `runtimeEnvironment`, you can override the database that needs exporting using the `DATABASE_ADDON_ID` variable.

Once added, create a Secret Group in the UI with the following keys:

| Key  | Use |
| ---- | --- |
| BACKUP_EXPORTER_TOKEN  | A NF token restricted to the project with `project:manage:read`, `addon:general:read` |
| S3_ENDPOINT  | If using 3rd party AWS providers (i.e. Cloudflare R2), provide this |
| S3_ACCESS_KEY_ID  | AWS access key |
| S3_SECRET_ACCESS_KEY  | AWS secret access key |
| S3_REGION  | AWS region |
| S3_BUCKET  | AWS bucket |

Copy-pastable ENV format:
```
BACKUP_EXPORTER_TOKEN=""
S3_ENDPOINT=""
S3_ACCESS_KEY_ID=""
S3_SECRET_ACCESS_KEY=""
S3_REGION=""
S3_BUCKET=""
```

Under `Advanced`, limit the secret group to the `backup-exporter-production` job.
