FROM node:22-bookworm-slim

ARG TERRAFORM_VERSION=1.17.1
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSLo "/tmp/terraform_${TERRAFORM_VERSION}_linux_amd64.zip" "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip" \
    && curl -fsSLo /tmp/terraform_SHA256SUMS "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_SHA256SUMS" \
    && cd /tmp \
    && grep "terraform_${TERRAFORM_VERSION}_linux_amd64.zip$" terraform_SHA256SUMS | sha256sum -c - \
    && unzip "/tmp/terraform_${TERRAFORM_VERSION}_linux_amd64.zip" -d /usr/local/bin \
    && rm -f "/tmp/terraform_${TERRAFORM_VERSION}_linux_amd64.zip" /tmp/terraform_SHA256SUMS

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production HOST=0.0.0.0 PORT=10000 SERVE_FRONTEND=false \
    TERRAFORM_BIN=/usr/local/bin/terraform \
    TERRAFORM_STATE_DIR=/var/data/terraform-state \
    TERRAFORM_PLUGIN_CACHE_DIR=/var/data/terraform-plugin-cache \
    OMNICLOUD_LOCAL_DOCKER_BUILDS=false

EXPOSE 10000
CMD ["npm", "start"]
