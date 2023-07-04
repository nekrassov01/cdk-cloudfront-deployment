#!/usr/bin/env bash

zip="https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip"

curl -s "$zip" -o "awscliv2.zip" || {
  echo "ERROR: Failed to download '$zip'"
  exit 1
}

unzip "awscliv2.zip" &>/dev/null
./aws/install --bin-dir /root/.pyenv/shims --install-dir /usr/local/aws-cli --update
rm -rf "awscliv2.zip" "aws"
