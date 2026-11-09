$yesterday = (Get-Date).AddDays(-1).ToString("yyyy-MM-dd")

# 1. List files changed since yesterday
node bin/azcopy-commander.js list --source-bucket amzn-s3-bucket-to-migrate  --source-region ap-southeast-2 --last-copy-date $yesterday
